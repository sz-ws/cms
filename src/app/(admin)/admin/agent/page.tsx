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
export default async function AgentPage() {
  await requireAuth("admin");

  const locale = await getLocale();
  const m = getMessages(locale);
  const registry = await buildAgentToolRegistry();
  const tools: AgentToolSummary[] = registry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    kind: tool.kind,
  }));

  return (
    <div className="flex flex-col gap-5">
      <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-1">
        <h1 className="text-[21px] font-semibold tracking-[-0.015em] text-black/90">
          {m["agent.title"]}
        </h1>
      </div>

      <AgentPanelLoader tools={tools} />
    </div>
  );
}
