import type { Prompter } from "./ui.js";

export interface AdminCredentials {
  email: string;
  password: string;
  name: string;
  siteTitle: string;
}

/**
 * 全新站一定要有的四個環境變數。順序就是問使用者的順序。
 *
 * 獨立成常數,是為了讓 deploy 能在 build **之前**先檢查一次:這些值到最後一步
 * (建第一個管理員)才用得到,但缺了就一定走不完 —— 讓人等完好幾分鐘的建置再說
 * 「你少給了 CMS_ADMIN_EMAIL」,是把可以立刻講的話留到最貴的時候講。
 */
export const ADMIN_ENV_KEYS = [
  "CMS_ADMIN_EMAIL",
  "CMS_ADMIN_NAME",
  "CMS_SITE_TITLE",
  "CMS_ADMIN_PASSWORD",
] as const;

/** 非互動下缺哪幾個。互動時使用者可以在提示裡補,所以呼叫端要自己先判斷。 */
export function missingAdminEnv(env: NodeJS.ProcessEnv): string[] {
  return ADMIN_ENV_KEYS.filter((key) => !env[key]?.trim());
}

/** 僅用在全新站；密碼不進 argv、Reporter 或 JSON transcript。 */
export async function adminCredentials(
  prompter: Prompter,
  interactive: boolean,
  env: NodeJS.ProcessEnv,
): Promise<AdminCredentials> {
  const get = async (key: string, label: string) => {
    const value = env[key];
    if (value) return value;
    if (!interactive) throw new Error(`First deployment requires ${key} in the environment (or an interactive terminal).`);
    return key === "CMS_ADMIN_PASSWORD" ? prompter.secret(label) : prompter.text(label);
  };
  const result = {
    email: (await get("CMS_ADMIN_EMAIL", "Administrator email")).trim(),
    name: (await get("CMS_ADMIN_NAME", "Administrator name")).trim(),
    siteTitle: (await get("CMS_SITE_TITLE", "Site title")).trim(),
    password: await get("CMS_ADMIN_PASSWORD", "Administrator password (at least 8 characters)"),
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email) || !result.name || !result.siteTitle || result.password.length < 8) {
    throw new Error("Administrator email, name, site title and a password of at least 8 characters are required.");
  }
  return result;
}

/**
 * SETUP_TOKEN 剛用 `wrangler secret put` 設上去,Cloudflare 的舊 isolate 不一定
 * 立刻帶到新值 —— 那時 /api/setup 會回 503 setup_token_not_configured。那是傳播
 * 時間差,不是設定錯誤,但使用者看到的是一次失敗的部署。
 *
 * 只對 503 重試(其他狀態一律立刻失敗:401/403 再等也不會變好)。
 */
const SETUP_RETRIES = 5;
const SETUP_RETRY_DELAY_MS = 3_000;

export async function bootstrapAdmin(
  origin: string, token: string, credentials: AdminCredentials, fetcher: typeof globalThis.fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetcher(`${origin}/api/setup`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ ...credentials, setupToken: token }),
    });
    // 回應原文不可進錯誤訊息，避免代理服務回顯包含憑證的 request body。
    if (response.ok) {
      const result = await response.json() as { ok?: unknown };
      if (result.ok !== true) throw new Error("Administrator setup did not confirm success.");
      return;
    }
    await response.body?.cancel();
    if (response.status === 503 && attempt < SETUP_RETRIES) {
      await sleep(SETUP_RETRY_DELAY_MS);
      continue;
    }
    throw new Error(response.status === 503
      ? `Administrator setup still returned HTTP 503 after ${SETUP_RETRIES} attempts over ${((SETUP_RETRIES - 1) * SETUP_RETRY_DELAY_MS) / 1000}s; the Worker has not picked up SETUP_TOKEN yet. Rerun cms deploy; existing users will not be replaced.`
      : `Administrator setup returned HTTP ${response.status}. Rerun cms deploy; existing users will not be replaced.`);
  }
}
