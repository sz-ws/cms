import { requireAuth } from "@/lib/auth";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { buildAgentToolRegistry } from "@/ext/agent-tools-runtime";
import { AgentPanelLoader } from "@/components/admin/agent/AgentPanelLoader";
import type { AgentToolSummary } from "@/components/admin/agent/tools";

export const dynamic = "force-dynamic";

// docs/spec-admin-agent.md §5:/admin/agent。
//
// **admin-only,兩道關**(spec §1.1,不可協商):sidebar 入口只在 role === "admin"
// 時渲染(admin/layout.tsx),這一頁自己再 requireAuth("admin")。兩道都要有 ——
// 入口不渲染只是「看不到」,直接輸入網址仍然到得了;而 API 端點各自也有第三道。
//
// tool 清單在 **server 端**取出後傳給面板(spec §5 的 Slash Command Dropdown 資料
// 來源)。不為它開新的 API 端點:清單只在「裝了/移除了 extension」的尺度上變動,
// 而那個尺度就是換頁;多一支端點只是多一個要防的 admin-only 表面。
// schema 不傳 —— 前端不驗參數(驗證只在 /execute,spec §4)。
//
// **頁首那一行整條交給 AgentPanelLoader**(含 <h1> 與「開新對話」)。這一頁只負責
// 把 server 端才拿得到的三樣東西遞下去:tool 清單、標題字、使用者 id。理由見
// AgentPanelLoader 檔頭 —— 簡短版是那顆按鈕必須與標題共用一行(零額外高度),而它
// 需要面板的狀態,所以持有它的必須是面板的**父層**而不是這個 server component。
export default async function AgentPage() {
  const user = await requireAuth("admin");

  const locale = await getLocale();
  const m = getMessages(locale);
  const registry = await buildAgentToolRegistry();
  const tools: AgentToolSummary[] = registry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    kind: tool.kind,
  }));

  return (
    // gap-5 是標題行與面板之間的距離 —— 面板高度的 calc 把它算進去了
    // (見 AgentPanelLoader 檔頭的推導),改這裡要一起改那裡。
    <div className="flex flex-col gap-5">
      <AgentPanelLoader
        tools={tools}
        title={m["agent.title"]}
        // 對話存在 localStorage,key 綁 user id —— 換人登入撿不到別人的對話
        // (見 components/admin/agent/persist.ts)。刻意不是 email:key 名在
        // devtools 裡是明文的。
        userId={user.id}
      />
    </div>
  );
}
