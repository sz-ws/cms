import { describe, expect, it } from "vitest";
import {
  ACCOUNT_LINK_HREF,
  accountSettingsLink,
  buildSettingsNav,
  findSettingsField,
  flattenSettingsNav,
  resolveSettingsHash,
  resolveSettingsSelection,
  settingsHref,
  settingsItemKey,
  settingsSectionStatus,
  settingsSelectionParams,
  type SettingsNavInput,
  type SettingsNavSection,
} from "../src/components/admin/settings-nav";
import { settingControlId } from "../src/lib/settings-ui";
import type { SettingField } from "../src/lib/settings";

// 設定頁左邊那一欄的清單、網址與標記(src/components/admin/settings-nav.ts)。純函式。

const general: SettingField[] = [
  { key: "core.siteTitle", label: { en: "Site title", "zh-Hant": "網站名稱" }, type: "text", default: "" },
  {
    key: "core.siteUrl",
    label: { en: "Site URL", "zh-Hant": "網站網址" },
    description: { en: "The address people use.", "zh-Hant": "客人連到網站的網址。" },
    type: "text",
    default: "",
  },
];
const ai: SettingField[] = [
  { key: "core.ai.model", label: { en: "Model", "zh-Hant": "模型" }, type: "text", default: "" },
];
const bank: SettingField[] = [
  { key: "bankName", label: "銀行名稱", type: "text", required: true, default: "" },
  { key: "note", label: "匯款說明", type: "textarea", default: "" },
];
const hold: SettingField[] = [
  { key: "holdMinutes", label: "付款期限", type: "number", default: 1440 },
];

const SECTIONS: SettingsNavSection[] = [
  { id: "core-general", title: "一般", description: "網站名稱、語言。", keyPrefix: "", fields: general },
  { id: "core-ai", title: "AI", keyPrefix: "", fields: ai },
  { id: "core-advanced", title: "進階", keyPrefix: "", fields: [] },
  { id: "transfer", title: "轉帳付款", keyPrefix: "ext.transfer.", fields: bank },
  { id: "store", title: "商店", keyPrefix: "ext.store.", fields: hold },
];

const AREA_LABELS = { core: "核心", style: "風格", declarative: "宣告式", extensions: "擴充功能" };

function input(over: Partial<SettingsNavInput> = {}): SettingsNavInput {
  return {
    sections: SECTIONS,
    locale: "zh-Hant",
    areaLabels: AREA_LABELS,
    panels: {
      aiConnect: { title: "AI 連線" },
      extraFields: { title: "額外欄位" },
      coreAddon: { title: "來源與權杖" },
      style: { title: "風格", keywords: "顏色 字體" },
      declarative: { title: "宣告式" },
    },
    ...over,
  };
}

const ids = (groups: ReturnType<typeof buildSettingsNav>) =>
  groups.map((group) => [group.area, group.items.map((item) => item.id)]);

describe("buildSettingsNav", () => {
  it("四個分類照原本分頁的順序,核心的附加區塊排在原本的位置", () => {
    const groups = buildSettingsNav(input());
    expect(ids(groups)).toEqual([
      ["core", ["core-general", "core-ai", "ai-connect", "core-advanced", "extra-fields", "core-addon"]],
      ["style", ["style"]],
      ["declarative", ["declarative"]],
      ["extensions", ["transfer", "store"]],
    ]);
    expect(groups.map((group) => group.label)).toEqual(["核心", "風格", "宣告式", "擴充功能"]);
  });

  it("沒有 AI 那一區時,AI 連線排在其他核心設定之後", () => {
    const groups = buildSettingsNav(input({ sections: SECTIONS.filter((s) => s.id !== "core-ai") }));
    expect(groups[0].items.map((item) => item.id)).toEqual([
      "core-general",
      "core-advanced",
      "ai-connect",
      "extra-fields",
      "core-addon",
    ]);
  });

  it("沒有內容的分類不出現", () => {
    const groups = buildSettingsNav(
      input({
        sections: SECTIONS.filter((s) => s.id.startsWith("core-")),
        panels: { declarative: { title: "宣告式" } },
      }),
    );
    expect(ids(groups)).toEqual([
      ["core", ["core-general", "core-ai", "core-advanced"]],
      ["declarative", ["declarative"]],
    ]);
  });

  it("欄位帶著這個語言的標題、說明與輸入框的 id", () => {
    const zh = flattenSettingsNav(buildSettingsNav(input()))[0];
    expect(zh.kind).toBe("fields");
    expect(zh.fields).toEqual([
      { fullKey: "core.siteTitle", controlId: settingControlId("core.siteTitle"), label: "網站名稱", description: "" },
      { fullKey: "core.siteUrl", controlId: settingControlId("core.siteUrl"), label: "網站網址", description: "客人連到網站的網址。" },
    ]);
    const en = flattenSettingsNav(buildSettingsNav(input({ locale: "en" })))[0];
    expect(en.fields.map((field) => field.label)).toEqual(["Site title", "Site URL"]);
    const ext = flattenSettingsNav(buildSettingsNav(input())).find((item) => item.id === "transfer");
    expect(ext?.fields[0].fullKey).toBe("ext.transfer.bankName");
    expect(ext?.fields[0].controlId).toBe(settingControlId("ext.transfer.bankName"));
  });

  it("附加區塊沒有欄位,帶著自己的搜尋用字", () => {
    const style = flattenSettingsNav(buildSettingsNav(input())).find((item) => item.area === "style");
    expect(style).toMatchObject({ kind: "panel", title: "風格", keywords: "顏色 字體", fields: [] });
  });
});

describe("resolveSettingsSelection", () => {
  const groups = buildSettingsNav(input());
  const pick = (tab?: string, section?: string) => resolveSettingsSelection(groups, { tab, section })?.key;

  it("沒有參數時是核心的第一區", () => {
    expect(pick()).toBe(settingsItemKey("core", "core-general"));
  });

  it("只有 ?tab= 時是那個分類的第一區(舊連結照舊)", () => {
    expect(pick("core")).toBe(settingsItemKey("core", "core-general"));
    expect(pick("style")).toBe(settingsItemKey("style", "style"));
    expect(pick("declarative")).toBe(settingsItemKey("declarative", "declarative"));
    expect(pick("extensions")).toBe(settingsItemKey("extensions", "transfer"));
  });

  it("不認得的 tab 回到核心", () => {
    expect(pick("nope")).toBe(settingsItemKey("core", "core-general"));
  });

  it("?tab= 指到的分類沒有東西時回到核心", () => {
    const bare = buildSettingsNav(input({ sections: SECTIONS.filter((s) => s.id.startsWith("core-")), panels: {} }));
    expect(resolveSettingsSelection(bare, { tab: "style" })?.id).toBe("core-general");
    expect(resolveSettingsSelection(bare, { tab: "extensions" })?.id).toBe("core-general");
  });

  it("有 section 就開那一區", () => {
    expect(pick("extensions", "store")).toBe(settingsItemKey("extensions", "store"));
    expect(pick(undefined, "core-ai")).toBe(settingsItemKey("core", "core-ai"));
    expect(pick(undefined, "ai-connect")).toBe(settingsItemKey("core", "ai-connect"));
    expect(pick(undefined, "store")).toBe(settingsItemKey("extensions", "store"));
  });

  it("section 不在 tab 那個分類裡,還是開得到", () => {
    expect(pick("extensions", "core-ai")).toBe(settingsItemKey("core", "core-ai"));
  });

  it("section 不存在時是 tab 那個分類的第一區", () => {
    expect(pick("extensions", "gone")).toBe(settingsItemKey("extensions", "transfer"));
    expect(pick(undefined, "gone")).toBe(settingsItemKey("core", "core-general"));
  });

  it("擴充功能的代號跟內建區塊同名時,以 tab 的分類為準", () => {
    const clash = buildSettingsNav(
      input({ sections: [...SECTIONS, { id: "style", title: "樣式外掛", keyPrefix: "ext.style.", fields: hold }] }),
    );
    expect(resolveSettingsSelection(clash, { tab: "extensions", section: "style" })?.title).toBe("樣式外掛");
    expect(resolveSettingsSelection(clash, { tab: "style" })?.area).toBe("style");
    expect(resolveSettingsSelection(clash, { tab: "style", section: "style" })?.area).toBe("style");
  });

  it("清單是空的時候沒有選取", () => {
    expect(resolveSettingsSelection([], { tab: "core" })).toBeNull();
  });
});

describe("resolveSettingsHash", () => {
  const groups = buildSettingsNav(input());

  it("#section-<id> 的舊連結開到那一區", () => {
    expect(resolveSettingsHash(groups, "#section-core-ai")?.item.id).toBe("core-ai");
    expect(resolveSettingsHash(groups, "#section-transfer", "extensions")?.item.id).toBe("transfer");
    expect(resolveSettingsHash(groups, "#section-extra-fields")?.item.id).toBe("extra-fields");
    expect(resolveSettingsHash(groups, "section-store")?.item.id).toBe("store");
  });

  it("欄位的 id 開到它所在的那一區,並帶著那個欄位", () => {
    const hit = resolveSettingsHash(groups, `#${settingControlId("ext.transfer.note")}`);
    expect(hit?.item.id).toBe("transfer");
    expect(hit?.field?.fullKey).toBe("ext.transfer.note");
  });

  it("不認得的 hash 不動", () => {
    expect(resolveSettingsHash(groups, "")).toBeNull();
    expect(resolveSettingsHash(groups, "#")).toBeNull();
    expect(resolveSettingsHash(groups, "#section-gone")).toBeNull();
    expect(resolveSettingsHash(groups, "#something-else")).toBeNull();
  });
});

describe("settingsSelectionParams / settingsHref", () => {
  const groups = buildSettingsNav(input());
  const item = (id: string) => flattenSettingsNav(groups).find((entry) => entry.id === id)!;

  it("每個分類的第一區不帶 section,核心不帶 tab", () => {
    expect(settingsSelectionParams(groups, item("core-general"))).toEqual({ tab: null, section: null });
    expect(settingsSelectionParams(groups, item("core-ai"))).toEqual({ tab: null, section: "core-ai" });
    expect(settingsSelectionParams(groups, item("style"))).toEqual({ tab: "style", section: null });
    expect(settingsSelectionParams(groups, item("transfer"))).toEqual({ tab: "extensions", section: null });
    expect(settingsSelectionParams(groups, item("store"))).toEqual({ tab: "extensions", section: "store" });
  });

  it("組出來的連結", () => {
    expect(settingsHref(groups, item("core-general"))).toBe("/admin/settings");
    expect(settingsHref(groups, item("core-addon"))).toBe("/admin/settings?section=core-addon");
    expect(settingsHref(groups, item("style"))).toBe("/admin/settings?tab=style");
    expect(settingsHref(groups, item("store"))).toBe("/admin/settings?tab=extensions&section=store");
  });

  it("每一區的連結都開得回同一區", () => {
    for (const entry of flattenSettingsNav(groups)) {
      const { tab, section } = settingsSelectionParams(groups, entry);
      expect(resolveSettingsSelection(groups, { tab, section })?.key).toBe(entry.key);
    }
  });
});

describe("findSettingsField", () => {
  it("用完整的設定 key 找到所在的區與欄位", () => {
    const groups = buildSettingsNav(input());
    const hit = findSettingsField(groups, "ext.store.holdMinutes");
    expect(hit?.item.id).toBe("store");
    expect(hit?.field.label).toBe("付款期限");
    expect(findSettingsField(groups, "ext.store.gone")).toBeNull();
  });
});

describe("settingsSectionStatus", () => {
  const baseline = {
    "core.siteTitle": "My Site",
    "core.siteUrl": "",
    "core.ai.model": "",
    "ext.transfer.bankName": "",
    "ext.transfer.note": "",
    "ext.store.holdMinutes": "1440",
  };
  const status = (
    over: Partial<Parameters<typeof settingsSectionStatus>[0]> = {},
    sections: SettingsNavSection[] = SECTIONS,
  ) => settingsSectionStatus({ sections, state: baseline, baseline, saved: {}, fieldErrors: {}, ...over });
  const core = (id: string) => settingsItemKey("core", id);
  const ext = (id: string) => settingsItemKey("extensions", id);

  it("改過還沒存的那一區才有「未儲存」", () => {
    const result = status({ state: { ...baseline, "core.siteTitle": "新名字", "ext.store.holdMinutes": "60" } });
    expect(result[core("core-general")].unsaved).toBe(true);
    expect(result[ext("store")].unsaved).toBe(true);
    expect(result[core("core-ai")].unsaved).toBe(false);
    expect(result[ext("transfer")].unsaved).toBe(false);
  });

  it("改回原本的值就不算", () => {
    expect(status({ state: { ...baseline } })[core("core-general")].unsaved).toBe(false);
  });

  it("必填欄位是空的那一區要提醒", () => {
    const result = status();
    expect(result[ext("transfer")].attention).toBe(true);
    expect(result[ext("store")].attention).toBe(false);
    expect(result[core("core-general")].attention).toBe(false);
  });

  it("只打空白也算空的;填了就不提醒", () => {
    expect(status({ state: { ...baseline, "ext.transfer.bankName": "   " } })[ext("transfer")].attention).toBe(true);
    expect(status({ state: { ...baseline, "ext.transfer.bankName": "第一銀行" } })[ext("transfer")].attention).toBe(false);
  });

  const keys: SettingsNavSection[] = [
    {
      id: "pay",
      title: "金流",
      keyPrefix: "ext.pay.",
      fields: [
        {
          key: "mode",
          label: "模式",
          type: "select",
          options: [{ value: "off", label: "關" }, { value: "live", label: "開" }],
          default: "off",
        },
        { key: "secret", label: "金鑰", type: "text", secret: true, required: true, default: "" },
        { key: "merchant", label: "商店代號", type: "text", required: true, default: "", showWhen: { key: "mode", equals: "live" } },
        { key: "hash", label: "雜湊", type: "text", required: true, default: "", enabledWhen: { key: "mode", oneOf: ["live"] } },
        { key: "sandbox", label: "測試模式", type: "boolean", required: true, default: false },
      ],
    },
  ];
  const payBase = { "ext.pay.mode": "off", "ext.pay.secret": "", "ext.pay.merchant": "", "ext.pay.hash": "", "ext.pay.sandbox": false };
  const pay = (over: Partial<Parameters<typeof settingsSectionStatus>[0]> = {}) =>
    status({ state: payBase, baseline: payBase, ...over }, keys)[ext("pay")];

  it("存過的密鑰畫面上是空的,不算沒填", () => {
    expect(pay({ saved: { "ext.pay.secret": "•••" } }).attention).toBe(false);
    expect(pay().attention).toBe(true);
    expect(pay({ state: { ...payBase, "ext.pay.secret": "sk-new" } }).attention).toBe(false);
  });

  it("沒顯示或不能填的必填欄位不算;開關沒有「空的」", () => {
    const saved = { "ext.pay.secret": "•••" };
    expect(pay({ saved }).attention).toBe(false);
    const live = { ...payBase, "ext.pay.mode": "live" };
    expect(pay({ saved, state: live }).attention).toBe(true);
    expect(pay({ saved, state: { ...live, "ext.pay.merchant": "M1", "ext.pay.hash": "h" } }).attention).toBe(false);
  });

  it("伺服器退回的欄位所在的那一區標成要修正", () => {
    const result = status({ fieldErrors: { "ext.store.holdMinutes": "expected_number" } });
    expect(result[ext("store")].error).toBe(true);
    expect(result[ext("transfer")].error).toBe(false);
  });
});

describe("accountSettingsLink", () => {
  it("連到帳戶頁的已連結帳號,登入方式的名字也能搜尋", () => {
    const link = accountSettingsLink(
      { title: "我的帳戶", description: "登入方式與已連結帳號", keywords: "登入 連結 綁定" },
      ["使用 Example ID 繼續", "  ", "使用 Example ID 繼續"],
    );
    expect(link.href).toBe(ACCOUNT_LINK_HREF);
    expect(ACCOUNT_LINK_HREF).toBe("/admin/account#connected-accounts");
    expect(link.title).toBe("我的帳戶");
    expect(link.keywords).toBe("登入 連結 綁定 使用 Example ID 繼續");
  });
});
