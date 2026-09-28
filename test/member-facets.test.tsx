import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 1.60.0:成員頁的插件 facet(Extension.memberFacets)。一個假插件「loyalty」宣告一個 facet
// 「會員等級」:core 讀它、驗它、隔離它的失敗,再交給表格、篩選、匯出與成員側欄。
// 表格與匯出經 users-data.ts 的整合測試在 users-export.test.ts;篩選在 users-filter.test.ts。

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, refresh: () => {}, push: () => {} }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) =>
    createElement("a", { href, className }, children),
}));

import {
  defineExtension,
  type Extension,
  type MemberFacet,
  type MemberFacetContext,
} from "../src/ext/types";
import { normalizeFacetValue, readMemberFacets } from "../src/ext/member-facets";
import type { CoreServices } from "../src/ext/services";
import { UserFacetSections } from "../src/app/(admin)/admin/users/UserFacetSections";
import type { UserRecord } from "../src/app/(admin)/admin/users/UsersTable";
import { usersCsvRows } from "../src/app/api/users/export/users-csv";
import { createDateFormatter } from "../src/lib/datetime";
import { getMessages } from "../src/lib/i18n";

const LOYALTY_SERVICES = { scope: "loyalty" } as unknown as CoreServices;

function tierFacet(read?: MemberFacet["read"]): MemberFacet {
  return {
    id: "tier",
    label: { "zh-Hant": "會員等級", en: "Tier" },
    read:
      read ??
      (async () => ({
        u1: { badge: "Gold", lines: [{ label: "點數", value: "120" }, { label: "到期", value: "2026-12-31" }] },
        u2: { badge: "Silver" },
        // 不在這一頁的人:略過。
        stranger: { badge: "X" },
      })),
    actions: [
      { label: { "zh-Hant": "查看等級", en: "Open tier" }, when: "has", href: (id, value) => `/admin/ext/loyalty?member=${id}&tier=${value?.badge}` },
      { label: { "zh-Hant": "加入會員等級", en: "Enrol" }, when: "missing", href: (id) => `/admin/ext/loyalty/new?member=${id}` },
    ],
  };
}

const loyalty = (facets: MemberFacet[] = [tierFacet()], id = "loyalty"): Extension => ({
  id,
  name: { "zh-Hant": "會員等級", en: "Loyalty" },
  version: "1.0.0",
  coreApi: "^1.60.0",
  memberFacets: facets,
});

const IDS = ["u1", "u2", "u3"];
const OPTIONS = { locale: "zh-Hant" as const, timeZone: "Asia/Taipei", services: () => LOYALTY_SERVICES };

let errors: MockInstance<typeof console.error>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
});

describe("readMemberFacets", () => {
  it("reads each facet once with every id, the locale, the time zone and the plugin's own services", async () => {
    const calls: { ids: string[]; ctx: MemberFacetContext }[] = [];
    const services = vi.fn(() => LOYALTY_SERVICES);
    const ext = loyalty([
      tierFacet(async (ids, ctx) => {
        calls.push({ ids, ctx });
        return { u1: { badge: "Gold" } };
      }),
    ]);
    const result = await readMemberFacets([ext], IDS, { ...OPTIONS, services });
    expect(calls).toHaveLength(1);
    expect(calls[0].ids).toEqual(IDS);
    expect(calls[0].ctx).toEqual({ services: LOYALTY_SERVICES, locale: "zh-Hant", timeZone: "Asia/Taipei" });
    expect(services).toHaveBeenCalledWith("loyalty");
    expect(result.facets).toEqual([{ key: "loyalty.tier", label: "會員等級" }]);
  });

  it("names the facet and its links in the admin language", async () => {
    const result = await readMemberFacets([loyalty()], IDS, { ...OPTIONS, locale: "en" });
    expect(result.facets).toEqual([{ key: "loyalty.tier", label: "Tier" }]);
    expect(result.byUser.get("u1")?.["loyalty.tier"].actions[0].label).toBe("Open tier");
  });

  it("gives each person the value, the lines and the links that apply", async () => {
    const { byUser } = await readMemberFacets([loyalty()], IDS, OPTIONS);
    expect(byUser.get("u1")).toEqual({
      "loyalty.tier": {
        value: { badge: "Gold", lines: [{ label: "點數", value: "120" }, { label: "到期", value: "2026-12-31" }] },
        actions: [{ label: "查看等級", href: "/admin/ext/loyalty?member=u1&tier=Gold" }],
      },
    });
    expect(byUser.get("u2")?.["loyalty.tier"]).toEqual({
      value: { badge: "Silver", lines: [] },
      actions: [{ label: "查看等級", href: "/admin/ext/loyalty?member=u2&tier=Silver" }],
    });
    // 沒有值:只有 missing 的連結。
    expect(byUser.get("u3")?.["loyalty.tier"]).toEqual({
      actions: [{ label: "加入會員等級", href: "/admin/ext/loyalty/new?member=u3" }],
    });
    expect(byUser.has("stranger")).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it("leaves out people with neither a value nor a link", async () => {
    const facet = { ...tierFacet(async () => ({ u1: { badge: "Gold" } })), actions: undefined };
    const { byUser } = await readMemberFacets([loyalty([facet])], IDS, OPTIONS);
    expect([...byUser.keys()]).toEqual(["u1"]);
  });

  it("drops invalid values and links, logging once per facet", async () => {
    const facet: MemberFacet = {
      ...tierFacet(async () => ({
        u1: { badge: "Gold" },
        u2: { badge: "" },
        u3: { badge: "Bronze", lines: [{ label: "點數" }] },
      }) as never),
      actions: [
        { label: "Always", when: "always", href: (id) => (id === "u1" ? "https://elsewhere.test/x" : `/admin/ext/loyalty?member=${id}`) },
        { label: "Broken", when: "has", href: () => {
          throw new Error("boom");
        } },
      ],
    };
    const { facets, byUser } = await readMemberFacets([loyalty([facet])], IDS, OPTIONS);
    expect(facets.map((f) => f.key)).toEqual(["loyalty.tier"]);
    expect(byUser.get("u1")?.["loyalty.tier"]).toEqual({ value: { badge: "Gold", lines: [] }, actions: [] });
    expect(byUser.get("u2")?.["loyalty.tier"]).toEqual({ actions: [{ label: "Always", href: "/admin/ext/loyalty?member=u2" }] });
    expect(byUser.get("u3")?.["loyalty.tier"].value).toBeUndefined();
    const logged = errors.mock.calls.map((call) => String(call[0]));
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain('ext="loyalty" facet="tier" dropped 2 value(s)');
    expect(logged[1]).toContain("dropped 2 action link(s)");
  });

  it("keeps the page when a facet throws, is slow, returns junk or has no services", async () => {
    const healthy = loyalty([tierFacet(async () => ({ u1: { badge: "Gold" } }))], "healthy");
    const broken = loyalty([tierFacet(async () => {
      throw new Error("boom");
    })], "broken");
    const syncThrow = loyalty([tierFacet(() => {
      throw new Error("sync boom");
    })], "sync");
    const slow = loyalty([tierFacet(() => new Promise(() => {}))], "slow");
    const junk = loyalty([tierFacet(async () => [] as never)], "junk");
    const noServices = loyalty([tierFacet()], "orphan");
    const services = (extId: string) => {
      if (extId === "orphan") throw new Error("no services");
      return LOYALTY_SERVICES;
    };
    const result = await readMemberFacets(
      [broken, syncThrow, slow, junk, noServices, healthy],
      IDS,
      { ...OPTIONS, services, timeoutMs: 20 },
    );
    expect(result.facets).toEqual([{ key: "healthy.tier", label: "會員等級" }]);
    expect(result.byUser.get("u1")).toEqual({ "healthy.tier": { value: { badge: "Gold", lines: [] }, actions: [{ label: "查看等級", href: "/admin/ext/loyalty?member=u1&tier=Gold" }] } });
    const logged = errors.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain('ext="broken" facet="tier" read failed');
    expect(logged).toContain('ext="sync" facet="tier" read failed');
    expect(logged).toContain('ext="slow" facet="tier" read took longer than 20ms');
    expect(logged).toContain('ext="junk" facet="tier" read returned array');
    expect(logged).toContain('ext="orphan" services unavailable');
  });

  it("does nothing when no plugin declares facets", async () => {
    const services = vi.fn(() => LOYALTY_SERVICES);
    const plain: Extension = { id: "plain", name: "Plain", version: "1.0.0", coreApi: "^1.60.0" };
    expect(await readMemberFacets([plain], IDS, { ...OPTIONS, services })).toEqual({ facets: [], byUser: new Map() });
    expect(services).not.toHaveBeenCalled();
  });
});

describe("normalizeFacetValue", () => {
  it("trims text and caps sizes", () => {
    expect(normalizeFacetValue({ badge: "  Gold  ", lines: [{ label: " 點數 ", value: " 120 " }] })).toEqual({
      badge: "Gold",
      lines: [{ label: "點數", value: "120" }],
    });
    expect(normalizeFacetValue({ badge: "x".repeat(33) })).toMatch(/badge/);
    expect(normalizeFacetValue({ badge: "ok", lines: Array.from({ length: 9 }, () => ({ label: "a", value: "b" })) })).toMatch(/lines/);
    expect(normalizeFacetValue({ badge: "ok\u0007" })).toMatch(/badge/);
    expect(normalizeFacetValue("Gold")).toMatch(/not an object/);
  });
});

describe("Extension.memberFacets manifest rules", () => {
  it("accepts facets on coreApi ^1.60.0", () => {
    expect(() => defineExtension(loyalty())).not.toThrow();
  });

  it("requires coreApi ^1.60.0", () => {
    expect(() => defineExtension({ ...loyalty(), coreApi: "^1.59.0" })).toThrow(/memberFacets requires coreApi "\^1\.60\.0"/);
  });

  it("rejects duplicate or malformed ids, unknown when and non-function read", () => {
    expect(() => defineExtension(loyalty([tierFacet(), tierFacet()]))).toThrow(/duplicate member facet id "tier"/);
    expect(() => defineExtension(loyalty([{ ...tierFacet(), id: "Tier!" }]))).toThrow(/invalid member facet id/);
    expect(() =>
      defineExtension(loyalty([{ ...tierFacet(), actions: [{ label: "x", when: "sometimes", href: () => "/admin" }] } as never])),
    ).toThrow(/memberFacets/);
    expect(() => defineExtension(loyalty([{ ...tierFacet(), read: "nope" } as never]))).toThrow(/expected function/);
    expect(() => defineExtension(loyalty([{ ...tierFacet(), label: { "zh-Hant": "" } }]))).toThrow(/memberFacets/);
  });
});

describe("the member sheet section", () => {
  const facets = [{ key: "loyalty.tier", label: "會員等級" }, { key: "points.wallet", label: "點數錢包" }];

  it("shows the lines as a label/value list and the links", () => {
    const html = renderToStaticMarkup(
      createElement(UserFacetSections, {
        facets,
        values: {
          "loyalty.tier": {
            value: { badge: "Gold", lines: [{ label: "點數", value: "120" }] },
            actions: [{ label: "查看等級", href: "/admin/ext/loyalty?member=u1" }],
          },
        },
      }),
    );
    expect(html).toContain("會員等級");
    expect(html).toMatch(/<dt[^>]*>點數<\/dt><dd[^>]*>120<\/dd>/);
    expect(html).toMatch(/<a href="\/admin\/ext\/loyalty\?member=u1"[^>]*>查看等級/);
    // 這個人跟點數錢包無關:那一段不出現。
    expect(html).not.toContain("點數錢包");
    // 有 lines 時不另寫 badge。
    expect(html).not.toContain("Gold");
  });

  it("writes the badge when there are no lines, and only links for people without a value", () => {
    const badgeOnly = renderToStaticMarkup(
      createElement(UserFacetSections, { facets, values: { "loyalty.tier": { value: { badge: "Silver", lines: [] }, actions: [] } } }),
    );
    expect(badgeOnly).toContain("Silver");
    const linkOnly = renderToStaticMarkup(
      createElement(UserFacetSections, {
        facets,
        values: { "points.wallet": { actions: [{ label: "開立錢包", href: "/admin/ext/points/new?member=u3" }] } },
      }),
    );
    expect(linkOnly).toContain("點數錢包");
    expect(linkOnly).toContain("開立錢包");
    expect(linkOnly).not.toContain("<dl");
  });

  it("renders nothing for a person no facet applies to", () => {
    expect(renderToStaticMarkup(createElement(UserFacetSections, { facets, values: undefined }))).toBe("");
  });
});

describe("CSV rows", () => {
  it("adds one column per facet with the badge, blank when it does not apply", () => {
    const zh = getMessages("zh-Hant");
    const base = { role: "guest" as const, staffRoleId: null, createdAt: Date.UTC(2026, 0, 1), passkeys: 0, lastActiveAt: null };
    const users: UserRecord[] = [
      { ...base, id: "u1", email: "a@example.com", name: "A", facets: { "loyalty.tier": { value: { badge: "Gold", lines: [] }, actions: [] } } },
      { ...base, id: "u3", email: "c@example.com", name: "C", facets: { "loyalty.tier": { actions: [{ label: "x", href: "/admin" }] } } },
    ];
    const rows = usersCsvRows(users, [], (key) => zh[key], createDateFormatter("zh-Hant", "Asia/Taipei"), [
      { key: "loyalty.tier", label: "會員等級" },
    ]);
    expect(rows[0]).toEqual(["姓名", "Email", "角色", "加入時間", "最近上線", "會員等級"]);
    expect(rows[1].at(-1)).toBe("Gold");
    expect(rows[2].at(-1)).toBe("");
  });
});
