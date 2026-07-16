import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { db } from "@/lib/db";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { listLoginProviders, listUserIdentities } from "@/lib/oidc";
import { passkeys, users } from "@/lib/schema";
import {
  PasskeysManager,
  type PasskeySummary,
} from "@/components/admin/PasskeysManager";
import { AvatarManager } from "@/components/admin/AvatarManager";
import {
  IdentitiesManager,
  type IdentitySummary,
} from "@/components/admin/IdentitiesManager";

export const dynamic = "force-dynamic";

// Paper & Ink 卡片語彙,層級抄 admin/settings/page.tsx(20px outer shell → 14px
// inner card)。role badge 走跟 token scope 一樣的 uppercase 小 pill,不借
// admin/users 那支舊版 ui.tsx 的 Badge(那是另一套尚未換裝的舊 UI)。
function RoleBadge({
  role,
  label,
}: {
  role: "admin" | "editor" | "guest";
  label: string;
}) {
  return (
    <span
      className={
        role === "admin"
          ? "inline-flex h-5 items-center rounded-full bg-black/[0.06] px-2 text-[11px] font-medium tracking-wide text-black/60 uppercase"
          : role === "guest"
            ? "inline-flex h-5 items-center rounded-full bg-black/[0.03] px-2 text-[11px] font-medium tracking-wide text-black/35 uppercase"
            : "inline-flex h-5 items-center rounded-full bg-black/[0.04] px-2 text-[11px] font-medium tracking-wide text-black/40 uppercase"
      }
    >
      {label}
    </span>
  );
}

// Date.now() 抽成獨立函式呼叫 —— 直接寫在 page 元件 body 裡會被
// react-hooks/purity 判定為「元件內呼叫 impure function」而擋下(即使這是 Server
// Component,linter 仍用「PascalCase + 回傳 JSX」的啟發式判斷是元件)。同一手法見
// src/components/admin/dashboard/aggregate.ts 的 Date.now()。
function requestTimestamp(): number {
  return Date.now();
}

function IdentityRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-t border-black/[0.06] py-3 first:border-t-0 first:pt-0 last:pb-0">
      <span className="text-[13px] text-black/45">{label}</span>
      {children}
    </div>
  );
}

// L1 §5:所有登入者可管理自己的 passkeys。settings 頁是 admin-only,故 passkey 管理
// 另立於此 /admin/account。spec-login-providers §3:guest 也要能管理自己的帳戶,
// 這是唯一放行 guest 的 admin 頁(requireAuth 最低門檻 "guest")。
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAuth("guest");
  const now = requestTimestamp();
  const locale = await getLocale();
  const m = getMessages(locale);
  // OAuth link 回跳的 flash(?linked=1 / ?error=<code>),交給 IdentitiesManager 顯示。
  const sp = await searchParams;
  const linkedFlash = sp.linked === "1";
  const identityError = typeof sp.error === "string" ? sp.error : undefined;

  // SessionUser 沒帶 createdAt(避免每次 session 檢查都多讀一欄);member-since 只有
  // 這頁需要,單獨查一次就好。
  const [self] = await db()
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, user.id));

  const rows = await db()
    .select({
      id: passkeys.id,
      name: passkeys.name,
      createdAt: passkeys.createdAt,
      lastUsedAt: passkeys.lastUsedAt,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, user.id));

  const initialPasskeys: PasskeySummary[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  }));

  // 第三方登入(spec-login-providers §6/§7):已綁 identities + 可綁 providers。
  // 日期在 server 端按 locale 格式化,client 元件不碰 Date。
  const dateLocale = locale === "zh-Hant" ? "zh-TW" : "en-US";
  const identityRows = await listUserIdentities(user.id);
  const identities: IdentitySummary[] = identityRows.map((i) => ({
    id: i.id,
    provider: i.provider,
    display: i.display,
    connectedAtLabel: new Date(i.createdAt).toLocaleDateString(dateLocale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
  }));
  const loginProviders = await listLoginProviders();
  const showIdentities = identities.length > 0 || loginProviders.length > 0;

  const memberSince = self
    ? new Date(self.createdAt).toLocaleDateString(
        locale === "zh-Hant" ? "zh-TW" : "en-US",
        {
          year: "numeric",
          month: "short",
          day: "numeric",
        },
      )
    : null;

  return (
    <div className="relative flex flex-col gap-6 pb-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/90">
          {m["account.title"]}
        </h1>
        <p className="text-[13px] leading-relaxed text-black/40">
          {m["account.subtitle"]}
        </p>
      </div>

      <section className="rounded-[20px] bg-white/55 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)] backdrop-blur-md">
        <div className="rounded-[14px] bg-white px-6 pt-6 pb-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
          <div className="mb-4 flex flex-col gap-1">
            <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-black/90">
              {m["account.identity"]}
            </h3>
            <p className="text-[12px] text-black/40">
              {m["account.whoYouAre"]}
            </p>
          </div>
          {/* 頭像:放 Identity 卡最上方(51a329f 後端)。 */}
          <div className="mb-4 border-b border-black/[0.06] pb-4">
            <AvatarManager name={user.name} avatarKey={user.avatarKey} />
          </div>
          <div className="flex flex-col">
            <IdentityRow label={m["account.email"]}>
              {isPlaceholderEmail(user.email) ? (
                // placeholder email(LINE 等拿不到 email 的 OAuth 帳號)遮罩顯示,
                // 不露內部合成字串(spec-login-providers §2)。
                <span className="text-[13px] text-black/35">
                  {m["account.noEmail"]}
                </span>
              ) : (
                <span className="text-[13px] font-medium text-black/85">
                  {user.email}
                </span>
              )}
            </IdentityRow>
            <IdentityRow label={m["account.role"]}>
              <RoleBadge
                role={user.role}
                label={
                  user.role === "admin"
                    ? m["account.roleAdmin"]
                    : user.role === "guest"
                      ? m["account.roleGuest"]
                      : m["account.roleEditor"]
                }
              />
            </IdentityRow>
            {memberSince && (
              <IdentityRow label={m["account.memberSince"]}>
                <span className="text-[13px] tabular-nums text-black/85">
                  {memberSince}
                </span>
              </IdentityRow>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-[20px] bg-white/55 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)] backdrop-blur-md">
        <div className="rounded-[14px] bg-white px-6 pt-6 pb-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
          <div className="mb-4 flex flex-col gap-1">
            <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-black/90">
              {m["account.signInMethods"]}
            </h3>
            <p className="text-[12px] text-black/40">
              {m["account.passkeyDesc"]}
            </p>
          </div>
          <PasskeysManager initialPasskeys={initialPasskeys} now={now} />

          {showIdentities && (
            <div className="mt-5 border-t border-black/[0.06] pt-5">
              <div className="mb-4 flex flex-col gap-1">
                <h4 className="text-[14px] font-semibold tracking-[-0.01em] text-black/85">
                  {m["account.connectedAccounts"]}
                </h4>
                <p className="text-[12px] text-black/40">
                  {m["account.connectedAccountsDesc"]}
                </p>
              </div>
              <IdentitiesManager
                initialIdentities={identities}
                providers={loginProviders}
                linked={linkedFlash}
                errorCode={identityError}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
