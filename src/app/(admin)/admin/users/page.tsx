import { count, max } from "drizzle-orm";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, passkeys, sessions } from "@/lib/schema";
import { UsersTable, type UserRecord, type RoleOption } from "./UsersTable";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { listStaffRoles } from "@/lib/staff-roles";
import { openablePageCount } from "@/ext/admin-access";
import { USERS_VIEW_PARAM, parseUsersView } from "./users-view";

export const dynamic = "force-dynamic";

// Date.now() 抽成獨立函式呼叫 —— 直接寫在元件 body 會被 react-hooks/purity 擋
// (linter 以「PascalCase + 回傳 JSX」啟發式認定元件,Server Component 也中)。
function requestTimestamp(): number {
  return Date.now();
}

// 04 §7:僅 admin role 可見(sidebar 過濾 + page 內 requireAuth("admin"))。
// SessionUser 不帶 createdAt/passkey 數 —— 這頁自己查,不動共用型別。
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const self = await requireAuth("admin");
  // 1.56.0:後台人員(預設)/ 會員。
  const initialView = parseUsersView((await searchParams)[USERS_VIEW_PARAM]);
  const now = requestTimestamp();
  const locale = await getLocale();
  const m = getMessages(locale);
  const title = m["users.title"];
  const subtitle = m["users.subtitle"];

  const [rows, pkCounts, lastSeen, staffRoles] = await Promise.all([
    db()
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        staffRoleId: users.staffRoleId,
        createdAt: users.createdAt,
      })
      .from(users),
    db()
      .select({ userId: passkeys.userId, n: count() })
      .from(passkeys)
      .groupBy(passkeys.userId),
    // Last active ≈ 最近一次 session 建立(sessions 會過期輪替,MAX(created_at)
    // 就是最近一次登入;比在 users 表加 last_login 欄位省一次寫路徑)。
    db()
      .select({ userId: sessions.userId, last: max(sessions.createdAt) })
      .from(sessions)
      .groupBy(sessions.userId),
    // 1.50.0:自訂角色(角色與權限頁建的),給每一列的角色選單。
    listStaffRoles(),
  ]);
  const roleOptions: RoleOption[] = staffRoles.map((role) => ({
    id: role.id,
    name: role.name,
    pages: openablePageCount(role.access),
  }));
  const pkByUser = new Map(pkCounts.map((r) => [r.userId, r.n]));
  const seenByUser = new Map(lastSeen.map((r) => [r.userId, r.last]));
  const list: UserRecord[] = rows.map((r) => ({
    ...r,
    passkeys: pkByUser.get(r.id) ?? 0,
    lastActiveAt: seenByUser.get(r.id) ?? null,
  }));

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
      <UsersTable initialUsers={list} roles={roleOptions} selfId={self.id} now={now} initialView={initialView} />
    </div>
  );
}
