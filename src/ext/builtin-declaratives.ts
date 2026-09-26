import { eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/lib/db";
import {
  declarativeExtensions as dxTable,
  settings as settingsTable,
} from "@/lib/schema";
import {
  CATALOG_EXT_ID,
  catalogManifest,
  catalogWanted,
} from "./commerce-kit/catalog";

// 1.49.0:底座自帶的宣告式 manifest(目前只有 commerce-kit 的商品目錄)。
//
// 它們跟 registry 裝來的一樣住在 declarative_extensions,所以所有讀那張表的地方照舊
// 運作;差別是那一列由這裡依 wanted() 對齊,不是由管理員安裝:
//   - wanted 且沒有那列 → 建立(連同設定預設值,已有的設定不動)
//   - wanted 且 manifest 跟底座這份不同或被停用 → 換成底座這份、啟用
//   - 不 wanted 且啟用中、而且是底座寫的(source = "builtin")→ 停用(列和內容都保留,
//     之後再 wanted 就回來)。從 registry 裝、站上又沒有商店的舊列不動 —— 只拿它
//     展示商品的站升級後照常運作,管理員也照舊能在擴充功能頁自己停用、移除。
// loader 每次完整載入時呼叫(部署後第一個 request 就換上新 manifest),設定改了也會
// 觸發(見 loader 的 builtinSig)。安裝、更新、啟停、移除這幾條 API 都拒絕這些 id。

export interface BuiltinContext {
  /** 目前啟用且可用的 code extension id。 */
  codeEnabled: ReadonlySet<string>;
  /** 讀一個非 secret 的設定(完整 key);沒有就是 undefined。 */
  setting: (key: string) => Promise<unknown>;
}

export interface BuiltinDeclarative {
  id: string;
  manifest: () => Record<string, unknown>;
  wanted: (ctx: BuiltinContext) => Promise<boolean>;
}

export const BUILTIN_DECLARATIVES: readonly BuiltinDeclarative[] = [
  { id: CATALOG_EXT_ID, manifest: catalogManifest, wanted: catalogWanted },
];

const BUILTIN_IDS = new Set(BUILTIN_DECLARATIVES.map((b) => b.id));

/** 底座寫入的列在 declarative_extensions.source 的標記(一般是 registry 網址)。 */
export const BUILTIN_SOURCE = "builtin";

export function isBuiltinDeclarative(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/** 這一列歸底座管:後台不列、不能在擴充功能頁啟停或移除。 */
export function isBaseManaged(id: string, source: string | null): boolean {
  return isBuiltinDeclarative(id) && source === BUILTIN_SOURCE;
}

/** 每個內建的應有狀態。讀設定失敗會丟例外 —— 讀不到就不該動資料庫。 */
export async function builtinWanted(ctx: BuiltinContext): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const builtin of BUILTIN_DECLARATIVES) out.set(builtin.id, await builtin.wanted(ctx));
  return out;
}

/** 應有狀態的指紋(例如 "catalog:1"),loader 拿來判斷 memo 還能不能用。 */
export function builtinSignature(wanted: ReadonlyMap<string, boolean>): string {
  return [...wanted].map(([id, on]) => `${id}:${on ? 1 : 0}`).join(",");
}

/** 對齊要看的欄位。 */
export interface BuiltinDeclarativeRow {
  id: string;
  manifest: string;
  enabled: number;
  source: string | null;
  updatedAt: number;
}

/**
 * 把資料庫對齊到 wanted。回傳有沒有寫入。
 *
 * knownRows:呼叫端手上已經有整張 declarative_extensions(loader 冷啟動的合併讀取,
 * @/lib/cold-snapshot)就傳進來,不再為了內建插件的那幾列多打一趟 D1。沒傳就自己查。
 */
export async function reconcileBuiltinDeclaratives(
  wanted: ReadonlyMap<string, boolean>,
  now: number = Date.now(),
  knownRows?: readonly BuiltinDeclarativeRow[],
): Promise<boolean> {
  const ids = BUILTIN_DECLARATIVES.map((b) => b.id);
  const rows: readonly BuiltinDeclarativeRow[] = knownRows
    ? knownRows.filter((row) => BUILTIN_IDS.has(row.id))
    : await db()
        .select({
          id: dxTable.id,
          manifest: dxTable.manifest,
          enabled: dxTable.enabled,
          source: dxTable.source,
          updatedAt: dxTable.updatedAt,
        })
        .from(dxTable)
        .where(inArray(dxTable.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const batch: BatchItem<"sqlite">[] = [];
  for (const builtin of BUILTIN_DECLARATIVES) {
    const row = byId.get(builtin.id);
    // updated_at 一定往前走,runtime stamp(MAX(updated_at))才會變。
    const at = row ? Math.max(now, row.updatedAt + 1) : now;

    if (!wanted.get(builtin.id)) {
      if (row && row.enabled === 1 && row.source === BUILTIN_SOURCE) {
        batch.push(
          db()
            .update(dxTable)
            .set({ enabled: 0, updatedAt: at })
            .where(eq(dxTable.id, builtin.id)),
        );
      }
      continue;
    }

    const manifest = builtin.manifest();
    const json = JSON.stringify(manifest);
    if (row && row.manifest === json && row.enabled === 1 && row.source === BUILTIN_SOURCE) continue;
    const version = String(manifest.version);
    batch.push(
      db()
        .insert(dxTable)
        .values({
          id: builtin.id,
          manifest: json,
          version,
          enabled: 1,
          source: BUILTIN_SOURCE,
          stylesheet: null,
          installedAt: at,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: dxTable.id,
          set: { manifest: json, version, enabled: 1, source: BUILTIN_SOURCE, stylesheet: null, updatedAt: at },
        }),
    );
    for (const field of settingFields(manifest)) {
      batch.push(
        db()
          .insert(settingsTable)
          .values({ key: `ext.${builtin.id}.${field.key}`, value: JSON.stringify(field.default), updatedAt: at })
          .onConflictDoNothing({ target: settingsTable.key }),
      );
    }
  }

  if (batch.length === 0) return false;
  await db().batch(batch as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return true;
}

function settingFields(manifest: Record<string, unknown>): { key: string; default: unknown }[] {
  const list = manifest.settings;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (f): f is { key: string; default: unknown } =>
      !!f && typeof f === "object" && typeof (f as { key?: unknown }).key === "string",
  );
}
