import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTING_GROUP,
  SETTING_GROUPS,
  groupSettingFields,
  settingGroupMeta,
} from "../src/lib/settings-ui";
import { CORE_SETTINGS } from "../src/lib/settings";

type Field = { key: string; group?: string };

describe("setting group derivation", () => {
  it("derives one card per declared group, ungrouped fields falling back", () => {
    const fields: Field[] = [
      { key: "a" },
      { key: "b", group: "email" },
      { key: "c", group: DEFAULT_SETTING_GROUP },
    ];
    const groups = groupSettingFields(fields);
    expect(groups.map((g) => g.id)).toEqual(["general", "email"]);
    expect(groups[0].fields.map((f) => f.key)).toEqual(["a", "c"]);
  });

  it("orders cards by the registry order, not by declaration order", () => {
    const fields: Field[] = [
      { key: "a", group: "advanced" },
      { key: "b", group: "ai" },
      { key: "c", group: "general" },
      { key: "d", group: "seo" },
      { key: "e", group: "email" },
    ];
    expect(groupSettingFields(fields).map((g) => g.id)).toEqual([
      "general",
      "seo",
      "email",
      "ai",
      "advanced",
    ]);
    // 同一組欄位換個宣告順序,卡片順序不能跟著變。
    const shuffled = [...fields].reverse();
    expect(groupSettingFields(shuffled).map((g) => g.id)).toEqual([
      "general",
      "seo",
      "email",
      "ai",
      "advanced",
    ]);
  });

  it("renders unregistered groups last, in field declaration order", () => {
    const fields: Field[] = [
      { key: "a", group: "zeta-lab" },
      { key: "b", group: "advanced" },
      { key: "c", group: "alpha" },
    ];
    const groups = groupSettingFields(fields);
    expect(groups.map((g) => g.id)).toEqual(["advanced", "zeta-lab", "alpha"]);
    expect(groups[1].title).toBe("Zeta lab");
    expect(groups[1].description).toBe("");
  });

  it("prefers i18n copy over the english literals, per group", () => {
    const groups = groupSettingFields([{ key: "a", group: "email" }], {
      "settings.group.email": "郵件",
      "settings.group.emailDesc": "寄信設定。",
    });
    expect(groups[0].title).toBe("郵件");
    expect(groups[0].description).toBe("寄信設定。");
    // 缺 key 就退回登記的英文字面值,不會渲染出空標題。
    const fallback = groupSettingFields([{ key: "a", group: "email" }], {});
    expect(fallback[0].title).toBe(settingGroupMeta("email").title);
  });

  it("keeps registry ids unique and orders strictly ascending", () => {
    const ids = SETTING_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = SETTING_GROUPS.map((g) => g.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("gives core.ai.* its own card instead of hiding it under advanced", () => {
    const groups = groupSettingFields(CORE_SETTINGS);
    const ai = groups.find((g) => g.id === "ai");
    expect(ai?.fields.map((f) => f.key)).toEqual([
      "core.ai.mode",
      "core.ai.baseUrl",
      "core.ai.apiKey",
      "core.ai.model",
    ]);
    const advanced = groups.find((g) => g.id === "advanced");
    expect(advanced?.fields.some((f) => f.key.startsWith("core.ai."))).toBe(false);
  });
});

// 1.43.0:中文後台的設定頁不再一半英文。畫在設定頁上的核心欄位,標題與說明都要有
// 中英兩版;選項可以是純字串(語言名稱、Workers AI 這種兩邊都一樣的)。
describe("core settings copy", () => {
  const HIDDEN = new Set(["core.registrySources", "core.registryTokens", "core.dashboard.insights"]);
  const shown = CORE_SETTINGS.filter((f) => !HIDDEN.has(f.key));
  const bilingual = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).en === "string" &&
    typeof (value as Record<string, unknown>)["zh-Hant"] === "string";

  it("every shown label and description has en and zh-Hant", () => {
    const missing = shown.flatMap((f) => [
      ...(bilingual(f.label) ? [] : [`${f.key}.label`]),
      ...(f.description === undefined || bilingual(f.description) ? [] : [`${f.key}.description`]),
    ]);
    expect(missing).toEqual([]);
  });

  it("descriptions do not cite spec documents", () => {
    const cites = shown.filter((f) => /spec-|core-v2|§/.test(JSON.stringify(f.description ?? "")));
    expect(cites.map((f) => f.key)).toEqual([]);
  });
});

// 1.44.0:寄信服務用分頁選;選 Resend 才出現 API 金鑰。
describe("email service setting", () => {
  const provider = CORE_SETTINGS.find((f) => f.key === "core.provider.email:send");
  const apiKey = CORE_SETTINGS.find((f) => f.key === "core.resendApiKey");

  it("選項就是 provider registry 裡 email:send 的 id", () => {
    expect(provider?.type).toBe("select");
    if (provider?.type !== "select") return;
    expect(provider.presentation).toBe("tabs");
    expect(provider.options.map((o) => o.value)).toEqual(["core", "cloudflare"]);
    expect(provider.options.every((o) => o.logo?.startsWith("/brand/email/"))).toBe(true);
  });

  // 1.46.1:比對的那兩行搬進 SettingsWorkspace(理由見那裡的註解),這裡只確認
  // showWhen 指到正確的欄位與值 —— 錯了的話金鑰欄位就會在選 Cloudflare 時還留著。
  it("API 金鑰只在選 Resend 時顯示", () => {
    expect(apiKey?.showWhen).toEqual({ key: "core.provider.email:send", equals: "core" });
    expect(provider?.default).toBe("core");
  });
});
