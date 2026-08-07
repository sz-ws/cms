import { AgentToolRegistryImpl } from "./agent-tools";
import type { AgentTool } from "./agent-tools";
import { coreAgentTools } from "./agent-tools-core";
import { listDeclarativeAgentTools } from "./dx/agent-tools";
import { agentToolIssues } from "./types";

// docs/spec-admin-agent.md §2:三個註冊來源收進**同一個** registry 的接線點。
// 這是 services.ts 的 buildProviderRegistry 在 agent 這一側的對應物 —— 每個需要
// tool 清單的地方(Phase B 組 LLM 的 tools[]、Phase C 的 /chat 與 /execute)都走
// 這一支,才不會出現「/chat 看得到的 tool 與 /execute 認得的 tool 不同」這種縫。
//
// 三個來源全數接妥(1.30.0):core 內建、declarative contentTypes 自動生成、
// 以及 enabled code extension 的 manifest `agentTools` 欄位。
//
// 每次呼叫重建 registry(不 memo):tool 物件本身很輕,而 declarative 那批直接
// 反映當下的 DB 內容 —— 剛安裝的 extension 應該在下一次對話就能被操作,快取只會
// 讓「裝了就會被操作」這個賣點延遲生效。真需要省的時候,該省的是 loader 那一層
// 已經在 memo 的東西。
//
// ── workers pool 注意事項 ────────────────────────────────────────────────────
// @/ext/loader 只能 dynamic import(同 agent-tools-core.ts 檔頭):靜態 import 會經
// interpret → views → next/navigation,把本檔連同它的測試一起弄成載不起來。

/**
 * enabled code extension 宣告的 tools(spec §2 表格第二列)。
 *
 * 「哪些 extension 是 enabled」刻意走 getExtRuntime()、不自己查 extensions 表:
 * runtime 已經把 coreApi 不相容 / migration 失敗的列排除在 `enabled` 之外,而一個
 * 載不起來的 extension 不該把它的動作交給 LLM(它的表可能還沒建好)。與另外兩個
 * 來源的取法一致 —— core 是編譯期常數,declarative 讀當下的 DB 列,這裡讀當下的
 * runtime,三者都不快取。
 *
 * rt.enabled 也含 interpret 過的 declarative extension,但 declarative manifest 是
 * JSON、裝不下 function,`agentTools` 永遠是 undefined —— 所以這個迴圈實際上只會
 * 撈到 code extension,不會與上面自動生成的 content.* tools 重複註冊。
 *
 * ── 為什麼壞掉的宣告是 throw,而不是像 declarative 那樣跳過 ────────────────────
 * dx/agent-tools.ts 對壞掉的 manifest 列一律跳過,理由是那是**使用者安裝的資料**,
 * 一列有問題不該讓整個面板打不開。code extension 是**編譯進 bundle 的程式碼**,而且
 * defineExtension 在 module-eval 當下就驗過同一組規則(agentToolIssues,同一個
 * 函式)—— 走到這裡還壞掉,代表有人繞過了 defineExtension 手寫物件,那是接線錯誤,
 * 應該當場知道。同理,重複 name 由 registry 自己 throw(providers.ts 的 fail-loud
 * 慣例)。
 *
 * 撞名在結構上幾乎不可能發生,而那正是 `<extId>.` 前綴規則的用處:兩個 code
 * extension 的 id 必不相同(loader 啟動時就檢查),所以它們的 tool 名不可能互撞;
 * core 一律 `core.` 前綴、生成的一律 `content.` 前綴,只有 id 剛好叫 "core" 或
 * "content" 的 extension 才碰得到那兩個命名空間 —— 而那也還是撞名,還是該炸。
 */
async function codeExtensionAgentTools(): Promise<AgentTool[]> {
  const { getExtRuntime } = await import("./loader");
  const rt = await getExtRuntime();
  const tools: AgentTool[] = [];
  for (const ext of rt.enabled) {
    const declared = ext.agentTools ?? [];
    if (declared.length === 0) continue;
    const issues = agentToolIssues(ext.id, declared);
    if (issues.length > 0) {
      throw new Error(
        `[agent-tools] extension "${ext.id}" declares invalid agentTools: ${issues.join("; ")}`,
      );
    }
    tools.push(...declared);
  }
  return tools;
}

/**
 * 建立含所有已知 agent tools 的 registry。
 *
 * 重複 name 由 registry throw —— 照 providers.ts 的 fail-loud 慣例,不吞。
 */
export async function buildAgentToolRegistry(): Promise<AgentToolRegistryImpl> {
  const registry = new AgentToolRegistryImpl();
  registry.registerAll(coreAgentTools());
  registry.registerAll(await listDeclarativeAgentTools());
  registry.registerAll(await codeExtensionAgentTools());
  return registry;
}
