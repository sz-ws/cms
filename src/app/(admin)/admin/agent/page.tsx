import Link from "next/link";
import { Sparkles } from "lucide-react";
import { requireAuth } from "@/lib/auth";
import { isAgentAvailable } from "@/lib/ai";
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

  // 1.39.0:AI 沒設定好時,側欄不給入口(admin/layout.tsx);直接打網址進來的人看到
  // 的是去設定的路,而不是一個每句話都回「尚未設定」的對話框。稽核頁不擋 —— 關掉
  // AI 之後,過去的執行紀錄照樣要查得到。
  if (!(await isAgentAvailable())) {
    return (
      <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-5">
        <h1 className="text-[21px] font-semibold tracking-[-0.015em] text-ink/90">
          {m["agent.title"]}
        </h1>
        <div className="flex flex-col items-start gap-4 rounded-[calc(20px*var(--admin-radius-scale,1))] bg-surface p-6 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]">
          <Sparkles aria-hidden className="size-5 text-ink/30" />
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-semibold text-ink/85">
              {m["agent.unavailable.title"]}
            </h2>
            <p className="text-[13px] text-ink/50">{m["agent.unavailable.body"]}</p>
          </div>
          <Link
            href="/admin/settings#section-core-ai"
            className="inline-flex h-8 items-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink px-3 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-ink/85 active:scale-[0.97]"
          >
            {m["agent.unavailable.action"]}
          </Link>
        </div>
      </div>
    );
  }

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
