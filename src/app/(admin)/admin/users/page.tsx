import { count, max } from "drizzle-orm";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, passkeys, sessions } from "@/lib/schema";
import { UsersTable, type UserRecord } from "./UsersTable";
import { getLocale, getMessages } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// Date.now() 抽成獨立函式呼叫 —— 直接寫在元件 body 會被 react-hooks/purity 擋
// (linter 以「PascalCase + 回傳 JSX」啟發式認定元件,Server Component 也中)。
function requestTimestamp(): number {
  return Date.now();
}

// 04 §7:僅 admin role 可見(sidebar 過濾 + page 內 requireAuth("admin"))。
// SessionUser 不帶 createdAt/passkey 數 —— 這頁自己查,不動共用型別。
export default async function UsersPage() {
  const self = await requireAuth("admin");
  const now = requestTimestamp();
  const locale = await getLocale();
  const m = getMessages(locale);
  const title = m["users.title"];
  const subtitle = m["users.subtitle"];

  const [rows, pkCounts, lastSeen] = await Promise.all([
    db()
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
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
  ]);
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
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/90">
          {title}
        </h1>
        <p className="text-[13px] leading-relaxed text-black/40">
          {subtitle}
        </p>
      </div>

      {/* 表格不包卡 —— 直接坐在畫布上,列 hover 時自己浮起(見 UsersTable)。 */}
      <UsersTable initialUsers={list} selfId={self.id} now={now} />
    </div>
  );
}
