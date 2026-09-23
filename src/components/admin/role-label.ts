import type { SessionUser } from "@/lib/auth";
import type { MessageKey } from "@/lib/i18n";

// 使用者看得到的角色名稱:自訂角色用它自己的名字,預設角色走 i18n。側欄的使用者區塊、
// 帳號選單與帳戶頁共用這一支,不直接印出 "admin" 這類內部代碼。
// 先看 staffRole:自訂角色的使用者在被授權的頁面裡 role 是 "admin"(見 SessionUser)。
export function roleLabel(
  user: Pick<SessionUser, "role" | "staffRole">,
  t: (key: MessageKey) => string,
): string {
  if (user.staffRole) return user.staffRole.name;
  if (user.role === "admin") return t("account.roleAdmin");
  if (user.role === "guest") return t("account.roleGuest");
  return t("account.roleEditor");
}
