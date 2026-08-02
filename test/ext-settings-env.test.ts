import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// getEnv 是 env 覆寫的來源,測試要能塞任意鍵進去,所以整個 mock 掉。
const fakeEnv: Record<string, unknown> = {};
vi.mock("@/lib/cf", () => ({
  getEnv: () => fakeEnv,
  getDB: () => (env as { DB: D1Database }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// D1 那半不是重點,只把 getSetting 換成可控的假資料。
// **必須保留其餘匯出**:services 的相依鏈(providers 等)還會用到 CORE_SETTINGS
// 之類的東西,整包換掉會在 import 期就炸,而且錯誤訊息完全指不到真因。
const d1Settings: Record<string, unknown> = {};
vi.mock("@/lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings")>()),
  getSetting: async (key: string, fallback?: unknown) =>
    key in d1Settings ? d1Settings[key] : fallback,
}));

const { makeScopedSettings, envKeyForSettingKey } = await import(
  "@/ext/settings-env"
);

// ⚠️ 下面 ENV_KEY_CASES 這張表在 `cli/src/settings.test.ts` 有**逐字元相同的一份**。
// 不在這裡直接 import CLI 模組,是因為它依賴 node:fs,在 workers pool 載不起來。
// 兩邊各自對同一張字面表斷言,任一邊的推導改了都會紅 —— 效果與共用一份實作相同。

const settingsFor = (extId: string) => makeScopedSettings(extId);

describe("CORE_API 1.27.0 — extension 設定的 env 覆寫", () => {
  beforeEach(() => {
    for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
    for (const k of Object.keys(d1Settings)) delete d1Settings[k];
  });

  describe("環境變數命名 — core 與 CLI 必須逐字元一致", () => {
    // 這一組是整個功能的接縫。分家的話:CLI 寫 A、core 讀 B,
    // 使用者會看到「設了卻沒生效」,而且兩邊各自的測試都會是綠的。
    const ENV_KEY_CASES: [extId: string, field: string, expected: string][] = [
      ["newebpay", "hashKey", "EXT_NEWEBPAY_HASH_KEY"],
      ["newebpay", "env", "EXT_NEWEBPAY_ENV"],
      ["sentry", "dsn", "EXT_SENTRY_DSN"],
      ["google-login", "clientId", "EXT_GOOGLE_LOGIN_CLIENT_ID"],
      ["a1", "apiKeyV2", "EXT_A1_API_KEY_V2"],
    ];

    it.each(ENV_KEY_CASES)("%s + %s → %s", (extId, field, expected) => {
      expect(envKeyForSettingKey(extId, `ext.${extId}.${field}`)).toBe(expected);
    });
  });

  it("env 有值時覆寫 D1", async () => {
    d1Settings["ext.newebpay.hashKey"] = "from-d1";
    fakeEnv.EXT_NEWEBPAY_HASH_KEY = "from-env";

    expect(await settingsFor("newebpay").get("ext.newebpay.hashKey", "")).toBe(
      "from-env",
    );
  });

  it("env 沒設時回頭讀 D1", async () => {
    d1Settings["ext.newebpay.hashKey"] = "from-d1";

    expect(await settingsFor("newebpay").get("ext.newebpay.hashKey", "")).toBe(
      "from-d1",
    );
  });

  it("空字串視為未設,不是「設成空」", async () => {
    // CLI 刻意不把 default 寫進 vars(那會產生看似設過的佔位值),
    // 這裡的判斷必須與那個決定對齊,否則佔位值會蓋掉 admin 裡填好的真值。
    d1Settings["ext.newebpay.hashKey"] = "from-d1";
    fakeEnv.EXT_NEWEBPAY_HASH_KEY = "   ";

    expect(await settingsFor("newebpay").get("ext.newebpay.hashKey", "")).toBe(
      "from-d1",
    );
  });

  it("依 fallback 型別轉換 boolean 與 number", async () => {
    fakeEnv.EXT_DEMO_ENABLED = "true";
    fakeEnv.EXT_DEMO_RETRIES = "5";

    const s = settingsFor("demo");
    expect(await s.get("ext.demo.enabled", false)).toBe(true);
    expect(await s.get("ext.demo.retries", 0)).toBe(5);
  });

  it("轉不動的值當作沒設 —— 轉壞的值比沒有值更難查", async () => {
    d1Settings["ext.demo.retries"] = 3;
    fakeEnv.EXT_DEMO_RETRIES = "abc";

    expect(await settingsFor("demo").get("ext.demo.retries", 0)).toBe(3);
  });

  it("env 覆寫不繞過 scope 檢查", async () => {
    // 越界的 key 必須照樣 throw,不能因為「env 裡剛好有這個變數」就放行。
    fakeEnv.EXT_OTHER_SECRET = "leaked";
    await expect(
      settingsFor("demo").get("ext.other.secret", ""),
    ).rejects.toThrow(/outside scope/);
  });

  it("一個 extension 讀不到另一個的 env 變數", async () => {
    fakeEnv.EXT_NEWEBPAY_HASH_KEY = "newebpay-secret";
    d1Settings["ext.demo.hashKey"] = "demo-own";

    expect(await settingsFor("demo").get("ext.demo.hashKey", "")).toBe(
      "demo-own",
    );
  });
});
