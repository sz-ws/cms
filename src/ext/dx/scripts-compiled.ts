import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { declarativeExtensions as dxTable } from "@/lib/schema";
import { overrideRegistry } from "../overrides";
import { surfaceIds } from "./surfaces";
import { buildInstallRevisionClaim } from "./declarative-migrate";
import { isStaleInstallConflict } from "./install-contract";
import { hashScripts, parseScriptsApproval } from "./scripts";
import type { DeclarativeManifest } from "./manifest";

// 1.51.0:插件的 scripts 已經由編進網站的程式碼取代(public:scripts,見 ./scripts-widget.tsx)。
//
// 後台每一道跟 script 有關的關卡都問同一個問題:
//   安裝 / 更新(api/registry/install)    —— 來源不必允許 script、不必核准,舊的核准清掉
//   安裝前預覽(api/registry/manifest)   —— 不回 script 資訊,商店不會開核准畫面
//   重新核准(api/extensions/[extId]/scripts)—— 拒絕(409 scripts_compiled)
//   商店索引、已安裝列表                   —— 一句「已編進網站」取代核准的提示
// 那些 script 永遠不會輸出,要人核准它只是讓人白看一段程式。
//
// 公開頁的 CSP 在 middleware 算。那是另一個 bundle,看不到編進來的程式碼,只看得到核准
// 紀錄(lib/public-csp.ts)。所以「被取代的 script 沒有有效的核准」是必須維持的狀態,
// 不然已經不會輸出的 script 的主機還留在白名單上:上面的安裝與核准守住新的寫入,
// 編進去之前就核准過的,由 loader 在完整載入時清掉(retireReplacedScriptApprovals)。
//
// 強化層在 extensions/registry.ts 的 import 鏈上登記,loader 靜態 import 那個檔。
// 呼叫端要 import 過 @/ext/loader,否則在剛啟動的 isolate 裡查到的是空的。

/** 這個宣告式插件的前台 scripts 已經由編進網站的程式碼取代。 */
export function scriptsCompiledIn(extId: string): boolean {
  return overrideRegistry.has(extId, surfaceIds.publicScripts());
}

/**
 * 已安裝列表的 script 狀態:沒有 scripts → null;編進網站 → "compiled";核准紀錄與
 * 目前內容對得上才算 "running"(與 scripts-widget 同一個判斷),其他 "stopped"。
 */
export async function installedScriptsState(
  extId: string,
  manifest: DeclarativeManifest | undefined,
  rawApproval: string | null,
): Promise<"compiled" | "running" | "stopped" | null> {
  if (!manifest?.scripts) return null;
  if (scriptsCompiledIn(extId)) return "compiled";
  const approval = parseScriptsApproval(rawApproval);
  if (!approval) return "stopped";
  return approval.hash === (await hashScripts(manifest.scripts)) ? "running" : "stopped";
}

interface ApprovalRow {
  id: string;
  scriptsApproval: string | null;
  updatedAt: number;
}

/**
 * 編進網站的插件,DB 裡還留著編進去之前的 script 核准 → 清掉(loader 完整載入時呼叫)。
 *
 * 同 1.49.0 內建插件的對齊:把「這次部署編進了什麼」寫回資料庫。一次部署只會真的寫
 * 一次 —— 清掉之後核准是 null,下一次完整載入就沒事可做。寫入推進 revision(跟停用
 * script 同一套 claim),loader 與 CSP 的版本戳都跟著換,下一個請求就看得見。
 * 同時有人在裝或更新這個插件時 claim 會撞 —— 那一邊按同樣規則清掉,這裡略過。
 *
 * 回傳是否動過資料庫(loader 據此不寫 memo)。
 */
export async function retireReplacedScriptApprovals(
  rows: readonly ApprovalRow[],
  now: number = Date.now(),
): Promise<boolean> {
  let wrote = false;
  for (const row of rows) {
    if (row.scriptsApproval === null || !scriptsCompiledIn(row.id)) continue;
    wrote = true;
    const at = Math.max(now, row.updatedAt + 1);
    try {
      await db().batch([
        buildInstallRevisionClaim(row.id, row.updatedAt, at),
        db()
          .update(dxTable)
          .set({ scriptsApproval: null, updatedAt: at })
          .where(eq(dxTable.id, row.id)),
      ]);
    } catch (e) {
      if (!isStaleInstallConflict(e)) throw e;
    }
  }
  return wrote;
}
