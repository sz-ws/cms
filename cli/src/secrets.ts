// 三把受管 Worker 金鑰的**單一定義來源**。產生與檢查的規則在 commands/managed-secrets.ts:
// 只補缺的、絕不覆寫、值不進 argv / 紀錄 / JSON,「讀不到」不等於「沒設定」。
//
// 絕不覆寫既有的值。SECRETS_KEY / AUTH_PEPPER 換掉都是不可逆的災難(見 MANAGED_SECRETS),
// 而 SETUP_TOKEN 換掉會讓一個還沒有管理員的站台把自己鎖在外面。

import { randomBytes } from "node:crypto";

export const SECRETS_KEY = "SECRETS_KEY";
export const AUTH_PEPPER = "AUTH_PEPPER";
export const SETUP_TOKEN = "SETUP_TOKEN";

export interface ManagedSecret {
  readonly name: string;
  /** 這把金鑰在做什麼 —— 問使用者要不要產生時要講得出理由。 */
  readonly why: string;
  /** 已存在時印的那一行,講清楚為什麼我們不覆寫。 */
  readonly neverRotate: string;
  /** true = 新產生時把值印出來給人看。只有 SETUP_TOKEN 是 true。 */
  readonly reveal?: boolean;
}

/**
 * setup / secrets 會產生的 worker secret。前兩把都是**產生後就不能換**的:
 *
 *   SECRETS_KEY  換掉 → 所有已加密的設定同時變亂碼(信封沒有 key id)。
 *   AUTH_PEPPER  它會被 HMAC 進每一次密碼雜湊,而雜湊字串裡記著「當初有沒有
 *                pepper」。設了之後再拔掉,所有既存密碼都算不出來 = 全站鎖死。
 *
 * AUTH_PEPPER 一定要在**建立第一個管理員之前**就存在,否則第一批密碼會以
 * 無 pepper 的形式落地。核心對這種情況是容忍的(照雜湊裡的旗標驗證,不會鎖死),
 * 但那些密碼在重設之前一直享受不到 pepper 的保護 —— 而 pepper 正是 Workers
 * 只能跑 100k iteration 這件事最需要的補償。
 */
export const MANAGED_SECRETS: readonly ManagedSecret[] = [
  {
    name: SECRETS_KEY,
    why: "encrypts every `secret: true` setting (registry tokens, Resend key, OIDC secret, payment keys)",
    neverRotate:
      "Not overwriting — rotating the key invalidates every stored encrypted setting, with no gradual migration path.",
  },
  {
    name: AUTH_PEPPER,
    why: "HMACs the password before hashing; without it an offline attack on a leaked database cannot even start",
    neverRotate:
      "Not overwriting — rotating it makes every existing password uncomputable, locking everyone out.",
  },
  {
    name: SETUP_TOKEN,
    why: "bootstrap credential for /setup; stops whoever finds the URL first from claiming the admin account",
    neverRotate: "Not overwriting — the site may have no admin yet; rotating it locks you out too.",
    // 唯一會被印出來的一把:它的用途就是給人貼進 /setup 的表單,而且建完
    // 第一個管理員之後就完全失效(那個端點從此一律回 403)。另外兩把印出來
    // 只有壞處 —— 它們的值永遠不需要被人眼看到。
    reveal: true,
  },
];

/** 32 byte base64 —— 與 DEPLOY.md 的 `openssl rand -base64 32` 等價。 */
export function defaultSecretGenerator(): string {
  return randomBytes(32).toString("base64");
}
