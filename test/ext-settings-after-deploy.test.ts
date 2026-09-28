import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 部署了新版插件、還沒按「套用更新」:新版宣告的設定照樣能用(core 1.63.0 發布說明答應店家「部署後就能改
// 銀行轉帳的『回報匯款時要填』」)。
//
// 機制:插件讀設定(services.settings.get)直接讀 settings 表,沒有列就用呼叫端給的預設;不看宣告過的清單,
// 也不看資料庫記的版本。設定頁的欄位與 PUT /api/settings 的白名單取自這次部署編進來的 manifest(getExtRuntime
// 的 enabled),不是資料庫裡的版本。「套用更新」對沒有 migration 的更新只做兩件事:把新設定的預設值寫進去(已經
// 有的不動)、記下版本 —— 設定能不能用不靠它。
//
// (直接下 SQL 改 settings 不經過 setSettings,公開頁最久要等 KV 裡的版本戳副本過期(5 分鐘)才讀到新值,見
// lib/stamps.ts;經過設定頁存的,下一個請求就是新的。)

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));
// 編進這次部署的插件只有銀行轉帳(下面 import 之後放進來;工廠裡不 import 它)。
const deployed = vi.hoisted(() => ({ extensions: [] as { id: string }[] }));
vi.mock("@/../extensions/registry", () => ({
  get registry() {
    return deployed.extensions;
  },
}));
// getSetting 讀到已存的設定列時會動態 import loader(判斷是不是 secret)。在這個測試池裡,好幾個這樣的讀取
// 同時發生會拿到真的 loader(它在這裡載不起來),所以銀行轉帳的三個回報設定一次只放一列。
const runtime = vi.hoisted(() => () => ({
  invalidateExtRuntimeMemo: () => undefined,
  getExtRuntime: async () => ({
    enabled: deployed.extensions,
    all: deployed.extensions,
    byId: (id: string) => deployed.extensions.find((ext) => ext.id === id),
    hooks: { doAction: async () => undefined },
  }),
}));
vi.mock("@/ext/loader", runtime);
vi.mock("@/ext/dx/cache-invalidate", () => ({ revalidateExt: () => undefined }));
// banktransfer 的後台頁會帶進 next/*,在 workers 測試池裡載不起來,換成最小的替身。
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => undefined, redirect: () => undefined, notFound: () => undefined }));

import { banktransfer } from "../extensions/banktransfer";
import { allowedSettingFields, allowedSettingKeys, getSetting, setSettings } from "../src/lib/settings";
import { enableStepSettings, pendingCodeUpgrades } from "../src/ext/manager";
import { makeScopedSettings } from "../src/ext/settings-env";
import { transferReportSpec } from "../src/ext/payment-kit/manual";
import type { CoreServices } from "../src/ext/services";

deployed.extensions = [banktransfer];

const d1 = () => (env as { DB: D1Database }).DB;
const STORED_VERSION = "0.1.2";
const REPORT_KEYS = ["ext.banktransfer.reportWith", "ext.banktransfer.referenceLabel", "ext.banktransfer.referenceDigits"];

/** 結帳頁與回報 API 拿到的那個 provider(banktransfer 的 provides,settings 綁在它自己的 scope)。 */
function paymentProvider(): unknown {
  const services = { settings: makeScopedSettings("banktransfer") } as unknown as CoreServices;
  return banktransfer.provides![0].create(services);
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM extensions; DELETE FROM ext_migrations; DELETE FROM settings;");
  // Installed at the old version, its one migration applied long ago; the report settings were never written.
  await d1().prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES ('banktransfer', 1, ?, 1, 1)").bind(STORED_VERSION).run();
  await d1().prepare("INSERT INTO ext_migrations (id, ext_id, applied_at) VALUES ('banktransfer:0001_orders', 'banktransfer', 1)").run();
});

describe("settings declared by the deployed code, before 套用更新", () => {
  it("the settings page shows them and the settings API accepts them: both follow the deployed manifest", async () => {
    const keys = await allowedSettingKeys();
    const fields = await allowedSettingFields();
    for (const key of REPORT_KEYS) expect(keys.has(key), key).toBe(true);
    expect(fields.get("ext.banktransfer.reportWith")).toMatchObject({ type: "select", default: "reference" });
  });

  it("with no rows the payment method asks for the documented default; a saved choice counts on the next read", async () => {
    const provider = paymentProvider();
    expect(await transferReportSpec(provider)).toEqual({ ask: "reference", reference: { label: "帳號末五碼", digits: 5 } });
    await setSettings({ "ext.banktransfer.reportWith": "payerName" });
    expect(await transferReportSpec(provider)).toEqual({ ask: "payerName", reference: { label: "帳號末五碼", digits: 5 } });
    const row = await d1().prepare("SELECT version FROM extensions WHERE id = 'banktransfer'").first<{ version: string }>();
    expect(row?.version).toBe(STORED_VERSION);
  });

  it("the extensions page still offers 套用更新 for the version; it writes only the missing defaults and records the version", async () => {
    expect((await pendingCodeUpgrades()).get("banktransfer")).toEqual({ from: STORED_VERSION, to: banktransfer.version, migrations: [] });
    await setSettings({ "ext.banktransfer.reportWith": "both" });
    const declared = (banktransfer.settings ?? []).length;
    expect(await enableStepSettings("banktransfer")).toBe(declared - 1);
    expect(await getSetting("ext.banktransfer.reportWith")).toBe("both");
    expect(await getSetting("ext.banktransfer.referenceDigits")).toBe(5);
  });
});
