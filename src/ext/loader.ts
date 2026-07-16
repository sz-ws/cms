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
import { computeExtRuntimeStamp } from "./runtime-stamp";
import type { Extension, HookName } from "./types";

// manifest.migrations 兜底已嘗試過的 extId(install route 是主要套用點;這裡
// 涵蓋 seed / 直寫 DB 的 row)。記的是「持久 DB 狀態的套用嘗試」而非 request
// 狀態,module 全域合法;失敗也記下,避免每 request 重打 DB(修復靠重新 install)。
const migrationsEnsured = new Set<string>();

// 跨 request 的 runtime memo。存的是「DB 衍生資料」(interpret 過的 Extension 陣列)
// 而非 request 狀態 —— 03 §3 禁的是把 request 狀態塞進 module 全域;這裡不同:memo
// 只放 DB 內容的解讀結果,沒有任何當次請求的資料。跨 isolate 的新鮮度靠「每個
// request 都重算 stamp 並比對」保證(不是 TTL)。命中就重用解讀結果(省下兩個
// SELECT + 每列 interpretManifest 的 zod parse/component build);未命中才走完整載入。
// HookBus 與回傳的 ExtRuntime 物件仍每 request 重建(HookBus.register 為純寫入、
// 不帶跨 request 狀態,重建成本低且安全)。
let runtimeMemo:
  | { stamp: string; codeEnabled: Extension[]; dxEnabled: Extension[] }
  | null = null;

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
}

// 03 §4:每個 request 第一次用到 extension 系統時,建立當次 request 的 runtime。
// 用 React cache() 做 per-request 快取,不可用 module 全域變數存 request 狀態。
export const getExtRuntime = cache(async (): Promise<ExtRuntime> => {
  // 1) 算 stamp(1 query)。失敗 → null,強制走完整載入且不寫 memo(§5:絕不 crash)。
  let stamp: string | null = null;
  try {
    stamp = await computeExtRuntimeStamp();
  } catch (e) {
    console.error(
      "[loader] runtime stamp query failed; falling back to full load",
      e,
    );
  }

  let codeEnabled: Extension[];
  let dxEnabled: Extension[];

  if (stamp !== null && runtimeMemo !== null && runtimeMemo.stamp === stamp) {
    // 命中:重用解讀過的陣列,省下兩個 SELECT + 每列 interpretManifest。
    codeEnabled = runtimeMemo.codeEnabled;
    dxEnabled = runtimeMemo.dxEnabled;
  } else {
    // 未命中(或 stamp 失敗):完整載入。
    // --- code extensions(既有機制)---
    const rows = await db()
      .select()
      .from(extTable)
      .where(eq(extTable.enabled, 1));
    const enabledIds = new Set(rows.map((r) => r.id));
    codeEnabled = registry.filter((e) => enabledIds.has(e.id));

    // --- declarative extensions(core-v2 §3.3:runtime list = code ∪ interpreted)---
    // ID 與 code 撞 → 跳過 declarative 並 log(§3.3)。無效 manifest 列 → interpret 回 null,
    // 亦跳過並 log(§5:絕不 crash loader)。code registry id 一律優先。
    const codeIds = new Set(registry.map((e) => e.id));
    const dxRows = await db()
      .select()
      .from(dxTable)
      .where(eq(dxTable.enabled, 1));

    const dx: Extension[] = [];
    const dxSeen = new Set<string>();
    for (const row of dxRows) {
      if (codeIds.has(row.id)) {
        console.error(
          `[loader] declarative extension "${row.id}" collides with a code extension id; skipped`,
        );
        continue;
      }
      if (dxSeen.has(row.id)) continue;
      const ext = interpretManifest({
        id: row.id,
        manifest: row.manifest,
        version: row.version,
        enabled: row.enabled,
      });
      if (!ext) continue; // interpret 已 log
      if (!migrationsEnsured.has(row.id)) {
        migrationsEnsured.add(row.id);
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
        } catch (e) {
          // §5:絕不 crash loader —— migration 失敗 log 之,extension 照常載入
          // (缺表的功能屆時自然報錯,可由重新 install 修復)。
          console.error(
            `[loader] declarative migrations for "${row.id}" failed:`,
            e,
          );
        }
      }
      dxSeen.add(row.id);
      dx.push(ext);
    }
    dxEnabled = dx;

    // 只有 stamp 成功時才寫 memo(失敗時無法在下個 request 驗證新鮮度,故不快取)。
    if (stamp !== null) {
      runtimeMemo = { stamp, codeEnabled, dxEnabled };
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
    isCompatible: (ext) => satisfies(CORE_API_VERSION, ext.coreApi),
  };
});
