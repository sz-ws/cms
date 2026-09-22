import { cache } from "react";
import { eq } from "drizzle-orm";
import { registry } from "@/../extensions/registry";
import { db } from "@/lib/db";
import {
  extensions as extTable,
  declarativeExtensions as dxTable,
} from "@/lib/schema";
import { HookBus } from "./hooks";
import { CORE_API_VERSION } from "./version";
import { satisfies } from "./semver";
import { interpretManifest } from "./dx/interpret";
import { runDeclarativeMigrations } from "./dx/declarative-migrate";
import { missingCapabilities } from "./features";
import {
  builtinSignature,
  builtinWanted,
  reconcileBuiltinDeclaratives,
} from "./builtin-declaratives";
import { getRequestStamps } from "@/lib/request-stamps";
import { getPlainSetting } from "@/lib/settings";
import type { Extension, HookName } from "./types";

// manifest.migrations 兜底已成功套用的 extId(install route 是主要套用點;這裡
// 涵蓋 seed / 直寫 DB 的 row)。失敗絕不寫入，下一個 request 必須再試；否則
// 一次暫態 D1 錯誤會把 extension 永久困在同一個 isolate 的半完成狀態。
const migrationsEnsured = new Set<string>();

export type ExtensionRuntimeIssue =
  | {
      kind: "core-api-incompatible";
      coreApi: string;
      coreVersion: string;
    }
  | { kind: "missing-core-api" }
  | { kind: "migration-failed" }
  | { kind: "load-failed" };

// 跨 request 的 runtime memo。存的是「DB 衍生資料」(interpret 過的 Extension 陣列)
// 而非 request 狀態 —— 03 §3 禁的是把 request 狀態塞進 module 全域;這裡不同:memo
// 只放 DB 內容的解讀結果,沒有任何當次請求的資料。跨 isolate 的新鮮度靠「每個
// request 都重算 stamp 並比對」保證(不是 TTL)。命中就重用解讀結果(省下兩個
// SELECT + 每列 interpretManifest 的 zod parse/component build);未命中才走完整載入。
// HookBus 與回傳的 ExtRuntime 物件仍每 request 重建(HookBus.register 為純寫入、
// 不帶跨 request 狀態,重建成本低且安全)。
let runtimeMemo:
  | {
      stamp: string;
      codeEnabled: Extension[];
      dxEnabled: Extension[];
      unavailableById: ReadonlyMap<string, ExtensionRuntimeIssue>;
      /** 1.49.0:建 memo 時內建宣告式插件的應有狀態(builtinSignature)。 */
      builtinSig: string;
    }
  | null = null;

/**
 * 1.49.0:內建宣告式插件的應有狀態。讀設定失敗回 null —— 讀不到就不對齊、不動資料庫
 * (否則一次暫態錯誤就可能把管理員關掉的東西重新打開)。
 */
async function wantedBuiltins(
  codeEnabled: readonly Extension[],
): Promise<Map<string, boolean> | null> {
  try {
    return await builtinWanted({
      codeEnabled: new Set(codeEnabled.map((ext) => ext.id)),
      setting: (key) => getPlainSetting(key),
    });
  } catch (e) {
    console.error("[loader] reading built-in extension settings failed", e);
    return null;
  }
}

/**
 * 主動失效 memo(belt-and-braces:同 isolate 的 mutation 後立即清,讓下個 request
 * 不必等 stamp 比對就重建)。跨 isolate 的正確性已由每 request 的 stamp 重算涵蓋。
 * 由 manager.ts 的 enable/disable/uninstall 與 install route 於寫入後呼叫。
 */
export function invalidateExtRuntimeMemo(): void {
  runtimeMemo = null;
}

// 03 §7:兩個 extension 的 id 重複 → registry 載入時 throw(在 loader 加檢查)。
// 首次 import 本 module 時執行一次。
(function assertUniqueIds(): void {
  const seen = new Set<string>();
  for (const e of registry) {
    if (seen.has(e.id)) {
      throw new Error(`[registry] duplicate extension id: ${e.id}`);
    }
    seen.add(e.id);
  }
})();

export interface ExtRuntime {
  enabled: Extension[]; // 只含 enabled=1 且存在於 registry 的
  all: Extension[]; // registry 全部(admin 的 extensions 頁要列出)
  hooks: HookBus;
  byId: (id: string) => Extension | undefined; // 只查 enabled
  // core-v2 §1:某 extension 的 coreApi 是否相容目前 CORE_API_VERSION
  // (/admin/extensions 用來標示不可啟用者)。
  isCompatible: (ext: Extension) => boolean;
  // enabled row 無法安全加入 runtime 時的管理介面診斷。這是 DB row 的衍生狀態，
  // 不寫回 enabled，修正 manifest / migration 後即可在下一次載入自然恢復。
  unavailableById: ReadonlyMap<string, ExtensionRuntimeIssue>;
}

function coreApiIssue(ext: Extension): ExtensionRuntimeIssue | null {
  // registry 雖由 TypeScript 約束為 Extension[]，仍要防禦手寫 JS / any 繞過
  // defineExtension。沒有契約不能假定相容，否則 CORE_API 又退回 advisory。
  if (typeof ext.coreApi !== "string" || ext.coreApi.trim().length === 0) {
    return { kind: "missing-core-api" };
  }
  return satisfies(CORE_API_VERSION, ext.coreApi)
    ? null
    : {
        kind: "core-api-incompatible",
        coreApi: ext.coreApi,
        coreVersion: CORE_API_VERSION,
      };
}

// 03 §4:每個 request 第一次用到 extension 系統時,建立當次 request 的 runtime。
// 用 React cache() 做 per-request 快取,不可用 module 全域變數存 request 狀態。
export const getExtRuntime = cache(async (): Promise<ExtRuntime> => {
  // 1) 取 stamp(與 settings 的指紋同一趟 D1,見 @/lib/request-stamps)。失敗 → null,
  //    強制走完整載入且不寫 memo(§5:絕不 crash)。
  const stamped = (await getRequestStamps()).extensions;
  if (!stamped.ok) {
    console.error(
      "[loader] runtime stamp query failed; falling back to full load",
      stamped.error,
    );
  }
  const stamp = stamped.ok ? stamped.stamp : null;

  let codeEnabled: Extension[];
  let dxEnabled: Extension[];
  let unavailableById: ReadonlyMap<string, ExtensionRuntimeIssue>;

  // 內建插件的應有狀態跟著設定(不在 extension stamp 裡):設定改了、指紋對不上,就當
  // memo 失效,走完整載入去對齊。讀不到設定(null)不算改變。
  let memoUsable =
    stamp !== null && runtimeMemo !== null && runtimeMemo.stamp === stamp;
  if (memoUsable && runtimeMemo !== null) {
    const wanted = await wantedBuiltins(runtimeMemo.codeEnabled);
    if (wanted !== null && builtinSignature(wanted) !== runtimeMemo.builtinSig) {
      memoUsable = false;
    }
  }

  if (memoUsable && runtimeMemo !== null) {
    // 命中:重用解讀過的陣列,省下兩個 SELECT + 每列 interpretManifest。
    codeEnabled = runtimeMemo.codeEnabled;
    dxEnabled = runtimeMemo.dxEnabled;
    unavailableById = runtimeMemo.unavailableById;
  } else {
    // 未命中(或 stamp 失敗):完整載入。
    // --- code extensions(既有機制)---
    const rows = await db()
      .select()
      .from(extTable)
      .where(eq(extTable.enabled, 1));
    const enabledIds = new Set(rows.map((r) => r.id));
    const unavailable = new Map<string, ExtensionRuntimeIssue>();
    codeEnabled = [];
    for (const ext of registry) {
      if (!enabledIds.has(ext.id)) continue;
      const issue = coreApiIssue(ext);
      if (issue) {
        unavailable.set(ext.id, issue);
        console.error(
          `[loader] code extension "${ext.id}" is unavailable: ${issue.kind}`,
        );
        continue;
      }
      codeEnabled.push(ext);
    }

    // --- 1.49.0:內建宣告式插件(commerce-kit 的商品目錄)先對齊,下面讀到的就是對的列 ---
    // 有寫入就不寫 memo:這次 request 開頭算的 stamp 已經過時,下一個 request 會重算。
    const wanted = await wantedBuiltins(codeEnabled);
    let builtinsSettled = wanted !== null;
    if (wanted !== null) {
      try {
        if (await reconcileBuiltinDeclaratives(wanted)) builtinsSettled = false;
      } catch (e) {
        console.error("[loader] reconciling built-in extensions failed", e);
        builtinsSettled = false;
      }
    }

    // --- declarative extensions(core-v2 §3.3:runtime list = code ∪ interpreted)---
    // ID 與 code 撞 → 跳過 declarative 並 log(§3.3)。無效 manifest 列 → interpret 回 invalid,
    // 亦跳過並 log(§5:絕不 crash loader)。code registry id 一律優先。
    const codeIds = new Set(registry.map((e) => e.id));
    const dxRows = await db()
      .select()
      .from(dxTable)
      .where(eq(dxTable.enabled, 1));

    const dx: Extension[] = [];
    const dxSeen = new Set<string>();
    let hasRetryableMigrationFailure = false;
    for (const row of dxRows) {
      if (codeIds.has(row.id)) {
        console.error(
          `[loader] declarative extension "${row.id}" collides with a code extension id; skipped`,
        );
        continue;
      }
      if (dxSeen.has(row.id)) continue;
      const interpreted = interpretManifest({
        id: row.id,
        manifest: row.manifest,
        version: row.version,
        enabled: row.enabled,
        scriptsApproval: row.scriptsApproval,
      });
      if (interpreted.status === "invalid") continue; // interpret 已 log
      if (interpreted.status === "incompatible") {
        const issue: ExtensionRuntimeIssue = {
          kind: "core-api-incompatible",
          coreApi: interpreted.coreApi,
          coreVersion: CORE_API_VERSION,
        };
        unavailable.set(row.id, issue);
        console.error(
          `[loader] declarative extension "${row.id}" requires coreApi "${interpreted.coreApi}" but core is ${CORE_API_VERSION}; excluded from runtime`,
        );
        continue;
      }
      const ext = interpreted.extension;
      if (!migrationsEnsured.has(row.id)) {
        try {
          const m = JSON.parse(row.manifest) as {
            migrations?: unknown;
            capabilities?: unknown;
          };
          if (Array.isArray(m.migrations) && m.migrations.length > 0) {
            await runDeclarativeMigrations(
              row.id,
              m.migrations.filter((s): s is string => typeof s === "string"),
            );
          }
          // roadmap #17:install route 是主要把關點(missing capability → 409 擋
          // 下);這裡是「已經在 DB 裡的 row」的兜底 —— §5:loader 絕不 crash,擋不下
          // 就照樣載入,只把不支援的功能名記進 log,讓功能在 runtime 自然失敗時有跡
          // 可循。reuse 上面已 parse 出的 m,不重複 JSON.parse manifest。
          if (Array.isArray(m.capabilities)) {
            const missing = missingCapabilities(
              m.capabilities.filter((s): s is string => typeof s === "string"),
            );
            if (missing.length > 0) {
              console.error(
                `[loader] declarative extension "${row.id}" requires unsupported features: ${missing.join(", ")}; loading anyway (features may fail at runtime)`,
              );
            }
          }
          migrationsEnsured.add(row.id);
        } catch (e) {
          // §5:絕不 crash loader —— migration 失敗時此 extension 不可用，但其他
          // extension 繼續。刻意不寫 migrationsEnsured，後續 request 能重試。
          console.error(
            `[loader] declarative migrations for "${row.id}" failed:`,
            e,
          );
          unavailable.set(row.id, { kind: "migration-failed" });
          hasRetryableMigrationFailure = true;
          continue;
        }
      }
      dxSeen.add(row.id);
      dx.push(ext);
    }
    dxEnabled = dx;
    unavailableById = unavailable;

    // migration 失敗不能 memo；否則同一個未變的 stamp 會讓下一 request 永遠
    // 命中「已排除」的快取而停止重試。其餘健康／不相容狀態仍可照常 memo。
    if (
      stamp !== null &&
      !hasRetryableMigrationFailure &&
      builtinsSettled &&
      wanted !== null
    ) {
      runtimeMemo = {
        stamp,
        codeEnabled,
        dxEnabled,
        unavailableById,
        builtinSig: builtinSignature(wanted),
      };
    }
  }

  // 以下每 request 重建(memo 只存 DB 衍生陣列,不存 HookBus/ExtRuntime)。
  const enabled = [...codeEnabled, ...dxEnabled];

  const hooks = new HookBus();
  for (const ext of enabled)
    for (const [name, fn] of Object.entries(ext.hooks ?? {}))
      hooks.register(ext.id, name as HookName, fn!);

  return {
    enabled,
    all: registry,
    hooks,
    byId: (id) => enabled.find((e) => e.id === id),
    isCompatible: (ext) => coreApiIssue(ext) === null,
    unavailableById,
  };
});
