import { requireAuth } from "@/lib/auth";
import { UsersTable } from "./UsersTable";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { loadUsers } from "./users-data";
import { parseUsersFilter } from "./users-filter";

export const dynamic = "force-dynamic";

// Date.now() 抽成獨立函式呼叫 —— 直接寫在元件 body 會被 react-hooks/purity 擋
// (linter 以「PascalCase + 回傳 JSX」啟發式認定元件,Server Component 也中)。
function requestTimestamp(): number {
  return Date.now();
}

// 04 §7:僅 admin role 可見(sidebar 過濾 + page 內 requireAuth("admin"))。
// 資料在 ./users-data.ts(匯出 CSV 讀同一份)。
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const self = await requireAuth("admin");
  const now = requestTimestamp();
  const locale = await getLocale();
  const m = getMessages(locale);
  const title = m["users.title"];
  const subtitle = m["users.subtitle"];

  const [params, { users, roles }] = await Promise.all([searchParams, loadUsers()]);
  // 1.56.0:後台人員(預設)/ 會員;1.59.0:搜尋與篩選也在網址上(./users-filter.ts)。
  const initialFilter = parseUsersFilter(params, roles.map((role) => role.id));

  return (
    <div className="relative flex flex-col gap-6 pb-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink/90">
          {title}
        </h1>
        <p className="text-[13px] leading-relaxed text-ink/40">
          {subtitle}
        </p>
      </div>

      {/* 表格不包卡 —— 直接坐在畫布上,列 hover 時自己浮起(見 UsersTable)。 */}
      <UsersTable initialUsers={users} roles={roles} selfId={self.id} now={now} initialFilter={initialFilter} />
    </div>
  );
}
