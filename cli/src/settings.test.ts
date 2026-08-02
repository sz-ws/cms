import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectAllSettings,
  defaultAsText,
  envKeyFor,
  localizedText,
  normalizeSetting,
  parseInputValue,
  readExtensionSettings,
  storageFor,
} from "./settings.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "szws-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeManifest(extId: string, manifest: unknown): Promise<void> {
  await mkdir(path.join(dir, extId), { recursive: true });
  await writeFile(
    path.join(dir, extId, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

describe("storageFor", () => {
  // 🔴 這是那條資安分界。secret 一旦被判成 "vars",值就會寫進會進版控的
  // wrangler.jsonc,而 cms 是公開 repo。
  it("secret: true 一律走 secret,沒有任何例外", () => {
    expect(storageFor({ secret: true })).toBe("secret");
  });

  it("secret 缺省 / false 才走 vars", () => {
    expect(storageFor({ secret: false })).toBe("vars");
  });
});

describe("envKeyFor", () => {
  it("加 extension 前綴並轉 UPPER_SNAKE", () => {
    expect(envKeyFor("newebpay", "hashKey")).toBe("EXT_NEWEBPAY_HASH_KEY");
    expect(envKeyFor("ai-smoke-test", "model")).toBe("EXT_AI_SMOKE_TEST_MODEL");
  });

  it("不同 extension 的同名 key 不會撞在一起(vars 是平坦命名空間)", () => {
    expect(envKeyFor("blog", "apiKey")).not.toBe(envKeyFor("cron", "apiKey"));
  });
});

describe("localizedText", () => {
  it("純字串原樣回傳", () => {
    expect(localizedText("Merchant ID")).toBe("Merchant ID");
  });

  it("per-locale 物件優先取 en", () => {
    expect(localizedText({ en: "Merchant", "zh-Hant": "商店代號" })).toBe("Merchant");
  });

  it("只有 zh-Hant 時退回 zh-Hant,而不是回空白", () => {
    expect(localizedText({ "zh-Hant": "商店代號" })).toBe("商店代號");
  });

  it("形狀不對回 undefined", () => {
    expect(localizedText(undefined)).toBeUndefined();
    expect(localizedText(42)).toBeUndefined();
  });
});

describe("normalizeSetting", () => {
  it("補齊 required / secret 的預設,並解析 label", () => {
    const field = normalizeSetting({
      key: "merchantId",
      label: { en: "Merchant ID", "zh-Hant": "商店代號" },
      description: "藍新商店代號。",
      type: "text",
      default: "",
    });
    expect(field).toMatchObject({
      key: "merchantId",
      label: "Merchant ID",
      description: "藍新商店代號。",
      required: false,
      secret: false,
      type: "text",
      options: [],
    });
  });

  it("select 帶進 options,label 缺省時用 value 當 label", () => {
    const field = normalizeSetting({
      key: "env",
      label: "環境",
      type: "select",
      default: "test",
      options: [{ value: "test", label: "測試機" }, { value: "core" }],
    });
    expect(field?.options).toEqual([
      { value: "test", label: "測試機" },
      { value: "core", label: "core" },
    ]);
  });

  it("形狀不合的一律回 null(manifest 可能來自任何 registry 來源,不能假設合規)", () => {
    expect(normalizeSetting(null)).toBeNull();
    expect(normalizeSetting({ key: "a" })).toBeNull();
    expect(normalizeSetting({ key: "a", type: "wat" })).toBeNull();
    expect(normalizeSetting({ key: "a", type: "select", default: "" })).toBeNull();
  });
});

describe("readExtensionSettings", () => {
  it("沒有 manifest.json → null(不是錯誤:code extension 不一定帶)", async () => {
    await mkdir(path.join(dir, "plain"), { recursive: true });
    await expect(readExtensionSettings(dir, "plain")).resolves.toBeNull();
  });

  it("讀得到 settings[],壞掉的項目記進 skipped 而不是靜默丟掉", async () => {
    await writeManifest("demo", {
      id: "demo",
      settings: [
        { key: "token", label: "Token", type: "text", default: "", secret: true, required: true },
        { key: "broken" },
      ],
    });
    const found = await readExtensionSettings(dir, "demo");
    expect(found?.settings.map((f) => f.key)).toEqual(["token"]);
    expect(found?.skipped).toHaveLength(1);
  });

  it("JSON 爛掉會 throw,不會被當成「沒有設定」", async () => {
    await mkdir(path.join(dir, "bad"), { recursive: true });
    await writeFile(path.join(dir, "bad", "manifest.json"), "{ not json", "utf8");
    await expect(readExtensionSettings(dir, "bad")).rejects.toThrow(/not valid JSON/);
  });
});

describe("collectAllSettings", () => {
  it("掃過每個目錄,壞掉的那個不會中斷其他的", async () => {
    await writeManifest("aaa", {
      settings: [{ key: "one", label: "One", type: "text", default: "" }],
    });
    await mkdir(path.join(dir, "bbb"), { recursive: true });
    await writeFile(path.join(dir, "bbb", "manifest.json"), "nope", "utf8");
    await writeManifest("ccc", {
      settings: [{ key: "two", label: "Two", type: "text", default: "" }],
    });

    const { extensions, errors } = await collectAllSettings(dir);
    expect(extensions.map((e) => e.extId)).toEqual(["aaa", "ccc"]);
    expect(errors).toHaveLength(1);
  });

  it("extensions/ 不存在 → 空結果,不 throw", async () => {
    const { extensions, errors } = await collectAllSettings(path.join(dir, "nope"));
    expect(extensions).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("parseInputValue", () => {
  it("number 只接受真的數字", () => {
    expect(parseInputValue("number", "42")).toEqual({ ok: true, value: 42 });
    expect(parseInputValue("number", "abc").ok).toBe(false);
    expect(parseInputValue("number", "  ").ok).toBe(false);
  });

  it("boolean 接受常見寫法", () => {
    expect(parseInputValue("boolean", "yes")).toEqual({ ok: true, value: true });
    expect(parseInputValue("boolean", "0")).toEqual({ ok: true, value: false });
    expect(parseInputValue("boolean", "maybe").ok).toBe(false);
  });

  it("text / textarea / select 原樣帶過", () => {
    expect(parseInputValue("text", " a b ")).toEqual({ ok: true, value: " a b " });
  });
});

describe("defaultAsText", () => {
  it("純量轉字串,其餘回空", () => {
    expect(defaultAsText("x")).toBe("x");
    expect(defaultAsText(3)).toBe("3");
    expect(defaultAsText(true)).toBe("true");
    expect(defaultAsText(undefined)).toBe("");
    expect(defaultAsText({})).toBe("");
  });
});

// ⚠️ 這張表在 `test/ext-settings-env.test.ts`(core 端)有**逐字元相同的一份**。
// core 的 envKeyForSettingKey() 與這裡的 envKeyFor() 是同一個對應的兩份實作 ——
// 分家就是「CLI 寫 A、core 讀 B」,使用者會看到「設了卻沒生效」而且無從查起。
// 不共用一份程式碼是因為 core 跑在 workers pool、CLI 依賴 node:fs,互相 import
// 不起來;各自對同一張字面表斷言可以達到一樣的效果。
describe("envKeyFor — 與 core 端共用的命名對照表", () => {
  const ENV_KEY_CASES: [extId: string, field: string, expected: string][] = [
    ["newebpay", "hashKey", "EXT_NEWEBPAY_HASH_KEY"],
    ["newebpay", "env", "EXT_NEWEBPAY_ENV"],
    ["sentry", "dsn", "EXT_SENTRY_DSN"],
    ["google-login", "clientId", "EXT_GOOGLE_LOGIN_CLIENT_ID"],
    ["a1", "apiKeyV2", "EXT_A1_API_KEY_V2"],
  ];

  it.each(ENV_KEY_CASES)("%s + %s → %s", (extId, field, expected) => {
    expect(envKeyFor(extId, field)).toBe(expected);
  });
});
