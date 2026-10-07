import { describe, expect, it } from "vitest";
import {
  accountSettingsLink,
  buildSettingsNav,
  type SettingsNavGroup,
  type SettingsNavLink,
  type SettingsNavSection,
} from "../src/components/admin/settings-nav";
import {
  firstSearchTarget,
  normalizeSearchText,
  searchSettingsNav,
} from "../src/components/admin/settings-search";
import { getMessages, type Locale } from "../src/lib/i18n/index";

// 設定頁的搜尋(src/components/admin/settings-search.ts)。純函式:比對區的標題、
// 欄位的標題與說明,結果照清單原本的順序。

const SECTIONS: SettingsNavSection[] = [
  {
    id: "core-general",
    title: "一般",
    description: "網站名稱、語言、時區與後台外觀。",
    keyPrefix: "",
    fields: [
      { key: "core.siteTitle", label: "網站名稱", type: "text", default: "" },
      { key: "core.siteUrl", label: "網站網址", description: "付款完成後的返回會用到它。", type: "text", default: "" },
    ],
  },
  {
    id: "core-email",
    title: "電子郵件",
    keyPrefix: "",
    fields: [
      { key: "core.emailFrom", label: "寄件地址", description: "客人收到的信會顯示這個地址。", type: "text", default: "" },
      { key: "core.emailKey", label: "API 金鑰", type: "text", secret: true, default: "" },
    ],
  },
  { id: "core-ai", title: "AI", keyPrefix: "", fields: [{ key: "core.ai.apiKey", label: "API 金鑰", type: "text", default: "" }] },
  {
    id: "store",
    title: "Store checkout",
    keyPrefix: "ext.store.",
    fields: [
      { key: "holdMinutes", label: "Payment window", description: "Minutes before an unpaid order is released.", type: "number", default: 1440 },
      { key: "notice", label: "Checkout note", type: "textarea", default: "" },
    ],
  },
];

const GROUPS: SettingsNavGroup[] = buildSettingsNav({
  sections: SECTIONS,
  locale: "zh-Hant",
  areaLabels: { core: "核心", style: "風格", declarative: "宣告式", extensions: "擴充功能" },
  panels: {
    coreAddon: { title: "來源與權杖", keywords: "擴充功能來源 API 權杖 匯出內容" },
    style: { title: "風格", keywords: "外觀 顏色 字體" },
  },
});

function accountLink(locale: Locale, providers: string[] = []): SettingsNavLink {
  const m = getMessages(locale);
  return accountSettingsLink(
    {
      title: m["settingsNav.account"],
      description: m["settingsNav.accountDesc"],
      keywords: m["settingsNav.accountKeywords"],
    },
    providers,
  );
}

const LINKS = [accountLink("zh-Hant")];

/** 結果攤平成「區 id → 命中的欄位 key」,比較好讀。 */
function hits(query: string, links: SettingsNavLink[] = LINKS) {
  const result = searchSettingsNav(GROUPS, links, query);
  if (!result) return null;
  return result.groups.flatMap((group) =>
    group.hits.map((hit) => [hit.item.id, hit.fields.map((field) => field.field.fullKey)] as const),
  );
}

describe("normalizeSearchText", () => {
  it("不分大小寫、去頭尾空白、全形當半形", () => {
    expect(normalizeSearchText("  API Key ")).toBe("api key");
    expect(normalizeSearchText("ＡＩ")).toBe("ai");
    expect(normalizeSearchText("寄件地址")).toBe("寄件地址");
  });
});

describe("searchSettingsNav", () => {
  it("沒打字(或只有空白)時不篩選", () => {
    expect(searchSettingsNav(GROUPS, LINKS, "")).toBeNull();
    expect(searchSettingsNav(GROUPS, LINKS, "   ")).toBeNull();
  });

  it("比對區的標題,不分大小寫、去掉頭尾空白", () => {
    expect(hits("  store ")).toEqual([["store", []]]);
    expect(hits("STORE")).toEqual([["store", []]]);
    expect(hits("ai")?.[0]).toEqual(["core-ai", []]);
    expect(hits("ＡＩ")).toEqual(hits("ai"));
  });

  it("三個字母以內的英數要在單字開頭,不會找到別的字中間的那幾個字母", () => {
    // 「ai」不該找到 unpaid;「pai」哪個字的開頭都不是。
    expect(hits("ai")).toEqual([["core-ai", []]]);
    expect(hits("pai")).toEqual([]);
    expect(hits("api")).toEqual([
      ["core-email", ["core.emailKey"]],
      ["core-ai", ["core.ai.apiKey"]],
      ["core-addon", []],
    ]);
    // 四個字母以上照舊,字中間也算(mail 找得到 email 這類字)。
    expect(hits("paid")).toEqual([["store", ["ext.store.holdMinutes"]]]);
    expect(hits("eckout")).toEqual([["store", ["ext.store.notice"]]]);
  });

  it("比對欄位的標題,欄位列在它的區底下", () => {
    expect(hits("寄件")).toEqual([["core-email", ["core.emailFrom"]]]);
    const result = searchSettingsNav(GROUPS, LINKS, "寄件");
    expect(result?.groups[0].hits[0].fields[0].matchedIn).toBe("label");
  });

  it("比對欄位的說明", () => {
    expect(hits("付款完成")).toEqual([["core-general", ["core.siteUrl"]]]);
    const result = searchSettingsNav(GROUPS, LINKS, "付款完成");
    expect(result?.groups[0].hits[0].fields[0].matchedIn).toBe("description");
    expect(hits("unpaid order")).toEqual([["store", ["ext.store.holdMinutes"]]]);
  });

  it("中文照打的字比對", () => {
    expect(hits("網站")).toEqual([["core-general", ["core.siteTitle", "core.siteUrl"]]]);
    expect(hits("郵件")).toEqual([["core-email", []]]);
  });

  it("結果照清單的順序,欄位照原本的順序", () => {
    expect(hits("金鑰")).toEqual([
      ["core-email", ["core.emailKey"]],
      ["core-ai", ["core.ai.apiKey"]],
    ]);
    const result = searchSettingsNav(GROUPS, LINKS, "a");
    expect(result?.groups.map((group) => group.area)).toEqual(["core", "extensions"]);
    expect(result?.groups.map((group) => group.label)).toEqual(["核心", "擴充功能"]);
  });

  it("空白隔開的每個字都要有;可以一個在區的標題、一個在欄位", () => {
    expect(hits("checkout note")).toEqual([["store", ["ext.store.notice"]]]);
    expect(hits("note checkout")).toEqual([["store", ["ext.store.notice"]]]);
    expect(hits("郵件 金鑰")).toEqual([["core-email", ["core.emailKey"]]]);
    expect(hits("郵件 網址")).toEqual([]);
  });

  it("區的說明與搜尋用字也算", () => {
    expect(hits("時區")).toEqual([["core-general", []]]);
    expect(hits("匯出")).toEqual([["core-addon", []]]);
    expect(hits("字體")).toEqual([["style", []]]);
  });

  it("什麼都沒有時 empty 是 true", () => {
    const result = searchSettingsNav(GROUPS, LINKS, "zzzz-沒有這個");
    expect(result?.groups).toEqual([]);
    expect(result?.links).toEqual([]);
    expect(result?.empty).toBe(true);
    expect(searchSettingsNav(GROUPS, LINKS, "寄件")?.empty).toBe(false);
  });
});

describe("帳戶連結的搜尋", () => {
  const found = (query: string, links: SettingsNavLink[]) =>
    searchSettingsNav(GROUPS, links, query)?.links.map((link) => link.href) ?? [];

  it("打「連結」「綁定」「登入」找得到", () => {
    for (const query of ["連結", "綁定", "登入", "帳號", "帳戶"]) {
      expect(found(query, LINKS), query).toEqual(["/admin/account#connected-accounts"]);
    }
  });

  it("英文後台也找得到", () => {
    const links = [accountLink("en")];
    for (const query of ["sign in", "login", "link", "connect", "account"]) {
      expect(found(query, links), query).toEqual(["/admin/account#connected-accounts"]);
    }
  });

  it("打登入方式的名字找得到(名字來自網站已啟用的登入方式,不寫在核心)", () => {
    expect(found("example id", LINKS)).toEqual([]);
    const withProvider = [accountLink("zh-Hant", ["使用 Example ID 繼續"])];
    expect(found("example id", withProvider)).toEqual(["/admin/account#connected-accounts"]);
    expect(found("EXAMPLE", [accountLink("en", ["Example ID"])])).toEqual(["/admin/account#connected-accounts"]);
  });

  it("核心的搜尋用字不寫任何一家登入服務的名字", () => {
    for (const locale of ["en", "zh-Hant"] as const) {
      const words = getMessages(locale)["settingsNav.accountKeywords"].toLowerCase();
      for (const brand of ["google", "line", "facebook", "apple", "github"]) {
        expect(words.split(/\s+/), `${locale}: ${brand}`).not.toContain(brand);
      }
    }
  });

  it("只有帳戶連結符合時不算沒有結果", () => {
    const result = searchSettingsNav(GROUPS, LINKS, "綁定");
    expect(result?.groups).toEqual([]);
    expect(result?.empty).toBe(false);
  });
});

describe("firstSearchTarget", () => {
  it("第一筆是區就開那一區,是欄位就開那個欄位", () => {
    const section = firstSearchTarget(searchSettingsNav(GROUPS, LINKS, "郵件")!);
    expect(section).toMatchObject({ kind: "item", item: { id: "core-email" } });
    expect(section && "field" in section ? section.field : undefined).toBeUndefined();

    const field = firstSearchTarget(searchSettingsNav(GROUPS, LINKS, "寄件")!);
    expect(field).toMatchObject({ kind: "item", item: { id: "core-email" }, field: { fullKey: "core.emailFrom" } });
  });

  it("只有連結符合時是那個連結;都沒有時是 null", () => {
    expect(firstSearchTarget(searchSettingsNav(GROUPS, LINKS, "綁定")!)).toMatchObject({
      kind: "link",
      link: { href: "/admin/account#connected-accounts" },
    });
    expect(firstSearchTarget(searchSettingsNav(GROUPS, LINKS, "zzzz")!)).toBeNull();
  });
});
