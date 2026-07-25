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
