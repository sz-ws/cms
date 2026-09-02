import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireAuth } from "@/lib/auth";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { listAgentAudit, formatAuditCursor } from "@/ext/agent-audit";
import { AuditLog } from "./AuditLog";
import { AuditFilters } from "./AuditFilters";
import { readAuditQuery, auditHref, type SearchParams } from "./audit-filter";

export const dynamic = "force-dynamic";

// docs/spec-admin-agent.md §1.3「admin 可在面板查看」與 §8 開放問題 2(「audit 表
// 要不要進 admin UI 的獨立頁」)—— 答案是要,而且是這一頁。理由:面板內折疊只看
// 得到**這一段對話**跑了什麼,而稽核要回答的是「這個站上助理做過什麼」,跨對話、
// 跨使用者、跨時間。那是另一種閱讀方式,塞進對話流裡只會兩邊都難用。
//
// admin-only 兩道關,同 /admin/agent:sidebar 入口本來就只給 admin(這一頁掛在
// 助理底下,連結在助理頁首),這裡再 requireAuth("admin")。
//
// 讀取只有一種形狀(最近 N 列 + 篩選,見 src/ext/agent-audit.ts 的說明);篩選與
// 翻頁全走 URL(audit-filter.ts),沒有新的 API 端點。

// Date.now() 抽成函式呼叫:直接寫在元件 body 會被 react-hooks/purity 擋
// (同 /admin/users/page.tsx)。
function requestTimestamp(): number {
  return Date.now();
}

interface AgentAuditPageProps {
  searchParams: Promise<SearchParams>;
}

export default async function AgentAuditPage({ searchParams }: AgentAuditPageProps) {
  await requireAuth("admin");
  const query = readAuditQuery(await searchParams);
  const [page, locale] = await Promise.all([listAgentAudit(query.filter), getLocale()]);
  const m = getMessages(locale);
  const now = requestTimestamp();

  const filtered = query.view !== "all" || query.tool !== null;
  const olderHref = page.nextCursor
    ? auditHref(query, formatAuditCursor(page.nextCursor))
    : null;

  return (
    <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-5 pb-6">
      <div className="flex flex-col gap-1.5">
        <Link
          href="/admin/agent"
          className="-ml-0.5 inline-flex w-fit items-center gap-1 text-[11.5px] text-black/35 transition-colors duration-150 hover:text-black/70"
        >
          <ArrowLeft className="size-3" />
          {m["agent.audit.back"]}
        </Link>
        <h1 className="text-[21px] font-semibold tracking-[-0.015em] text-black/90">
          {m["agent.audit.title"]}
        </h1>
        <p className="text-[13px] leading-relaxed text-black/40">
          {m["agent.audit.subtitle"]}
        </p>
      </div>

      <AuditFilters view={query.view} tool={query.tool} />

      <AuditLog
        rows={page.rows}
        now={now}
        view={query.view}
        tool={query.tool}
        empty={filtered ? m["agent.audit.emptyFiltered"] : m["agent.audit.empty"]}
      />

      {olderHref && (
        <div className="flex justify-center">
          <Link
            href={olderHref}
            className="inline-flex h-9 items-center rounded-[8px] bg-white px-3.5 text-[13px] font-medium text-black/70 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] transition-[color,box-shadow] duration-150 hover:text-black/90 hover:shadow-[0_0_0_1px_rgba(0,0,0,0.1),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] active:scale-[0.98]"
          >
            {m["agent.audit.older"]}
          </Link>
        </div>
      )}
    </div>
  );
}
