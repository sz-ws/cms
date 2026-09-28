import { describe, expect, it } from "vitest";
import { getMessages } from "../src/lib/i18n";
import type { UserRecord } from "../src/app/(admin)/admin/users/UsersTable";
import {
  emptyUsersFilter,
  filterUsers,
  hrefForUsersFilter,
  isUsersFiltered,
  parseUsersFilter,
  roleLabel,
  switchUsersView,
  usersFilterParams,
  withFacetChoice,
  type UsersFilter,
} from "../src/app/(admin)/admin/users/users-filter";

// 1.59.0:成員頁的搜尋與篩選。畫面與 GET /api/users/export 共用這一份,
// 這裡鎖住:分組、搜尋、兩種日期區間(站台時區)、角色、網址的讀寫。

const TZ = "Asia/Taipei";
/** 台北的牆上時間 → epoch ms(UTC+8,沒有夏令時間)。 */
const taipei = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 8, min);

function user(id: string, extra: Partial<UserRecord>): UserRecord {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    role: "guest",
    staffRoleId: null,
    createdAt: taipei(2026, 1, 1),
    passkeys: 0,
    lastActiveAt: null,
    ...extra,
  };
}

const USERS: UserRecord[] = [
  user("admin", { name: "Alice Admin", email: "alice@example.com", role: "admin", createdAt: taipei(2026, 1, 10), lastActiveAt: taipei(2026, 9, 27, 10) }),
  user("editor", { name: "Bob Staff", email: "bob@example.com", role: "editor", createdAt: taipei(2026, 3, 5) }),
  // 自訂角色:role 存 guest,看 staffRoleId(migrations/0021)。9/1 00:30 台北 = 8/31 16:30 UTC。
  user("clerk", { name: "Carol", email: "carol@example.com", staffRoleId: "r-clerk", createdAt: taipei(2026, 6, 1), lastActiveAt: taipei(2026, 9, 1, 0, 30) }),
  user("ming", { name: "王小明", email: "Ming@Example.COM", createdAt: taipei(2026, 9, 1, 0, 5), lastActiveAt: taipei(2026, 9, 28, 9) }),
  user("dana", { name: "Dana", email: "dana@example.org", createdAt: taipei(2026, 8, 31, 23, 59), lastActiveAt: taipei(2026, 9, 2) }),
  // 第三方登入拿不到 email:畫面遮成「未提供 email」,搜尋也不該比對到合成的字串。
  user("line", { name: "Line User", email: "oauth-line-abcd1234@placeholder.invalid", createdAt: taipei(2026, 9, 15) }),
];

const ids = (list: readonly UserRecord[]) => list.map((u) => u.id);

function filter(extra: Partial<UsersFilter>): UsersFilter {
  return { ...emptyUsersFilter(), ...extra };
}

function run(extra: Partial<UsersFilter>, timeZone = TZ): string[] {
  return ids(filterUsers(USERS, filter(extra), timeZone));
}

describe("filterUsers — group", () => {
  it("splits staff (presets and custom roles) from members, keeping the order", () => {
    expect(run({ view: "staff" })).toEqual(["admin", "editor", "clerk"]);
    expect(run({ view: "members" })).toEqual(["ming", "dana", "line"]);
  });
});

describe("filterUsers — search", () => {
  it("matches name or email, case-insensitive, anywhere in the text", () => {
    expect(run({ q: "ALICE" })).toEqual(["admin"]);
    expect(run({ q: "staff" })).toEqual(["editor"]);
    expect(run({ view: "members", q: "example.com" })).toEqual(["ming"]);
    expect(run({ view: "members", q: "小明" })).toEqual(["ming"]);
    expect(run({ view: "members", q: "  dana " })).toEqual(["dana"]);
  });

  it("folds full-width letters typed through an input method", () => {
    expect(run({ view: "members", q: "ｍｉｎｇ" })).toEqual(["ming"]);
  });

  it("never matches the hidden placeholder email, only the name", () => {
    expect(run({ view: "members", q: "placeholder" })).toEqual([]);
    expect(run({ view: "members", q: "oauth-line" })).toEqual([]);
    expect(run({ view: "members", q: "line user" })).toEqual(["line"]);
  });

  it("searches inside the chosen group only", () => {
    expect(run({ view: "staff", q: "dana" })).toEqual([]);
  });
});

describe("filterUsers — joined dates (site time zone, both ends included)", () => {
  it("counts a day from 00:00 in the site time zone", () => {
    expect(run({ view: "members", joined: { from: "2026-09-01", to: null } })).toEqual(["ming", "line"]);
    expect(run({ view: "members", joined: { from: null, to: "2026-08-31" } })).toEqual(["dana"]);
    expect(run({ view: "members", joined: { from: "2026-09-01", to: "2026-09-01" } })).toEqual(["ming"]);
  });

  it("depends on the time zone it is given", () => {
    // 王小明 joined 9/1 00:05 in Taipei, which is still 8/31 in UTC.
    expect(run({ view: "members", joined: { from: "2026-09-01", to: "2026-09-01" } }, "UTC")).toEqual([]);
    expect(run({ view: "members", joined: { from: "2026-08-31", to: "2026-08-31" } }, "UTC")).toEqual(["ming", "dana"]);
  });
});

describe("filterUsers — last active dates", () => {
  it("filters by the last sign-in day; never signed in never matches a range", () => {
    expect(run({ active: { from: "2026-09-01", to: "2026-09-01" } })).toEqual(["clerk"]);
    expect(run({ active: { from: "2026-09-02", to: null } })).toEqual(["admin"]);
    expect(run({ active: { from: null, to: "2026-12-31" } })).toEqual(["admin", "clerk"]);
    expect(run({ view: "members", active: { from: "2026-09-01", to: "2026-09-30" } })).toEqual(["ming", "dana"]);
  });

  it("keeps people who never signed in when no range is set", () => {
    expect(run({ view: "members" })).toContain("line");
  });
});

describe("filterUsers — role", () => {
  it("filters staff by preset or custom role", () => {
    expect(run({ roles: ["role:r-clerk"] })).toEqual(["clerk"]);
    expect(run({ roles: ["admin", "editor"] })).toEqual(["admin", "editor"]);
  });

  it("ignores roles in the members group", () => {
    expect(run({ view: "members", roles: ["admin"] })).toEqual(["ming", "dana", "line"]);
  });

  it("combines every condition", () => {
    expect(run({ roles: ["admin", "role:r-clerk"], q: "a", active: { from: "2026-09-20", to: null } })).toEqual(["admin"]);
    expect(run({ view: "members", q: "example", joined: { from: "2026-09-01", to: null } })).toEqual(["ming"]);
  });
});

describe("parseUsersFilter", () => {
  const ROLE_IDS = ["r-clerk"];

  it("reads every condition from the URL", () => {
    const params = new URLSearchParams(
      "view=members&q=%20王%20&joinedFrom=2026-09-01&joinedTo=2026-09-30&activeFrom=2026-09-10",
    );
    expect(parseUsersFilter(params, ROLE_IDS)).toEqual({
      view: "members",
      q: "王",
      roles: [],
      joined: { from: "2026-09-01", to: "2026-09-30" },
      active: { from: "2026-09-10", to: null },
      facets: {},
    });
  });

  it("drops values it does not know, swaps a reversed range", () => {
    const params = new URLSearchParams(
      "view=nope&role=role:r-clerk,admin,role:gone,bogus&joinedFrom=2026-09-30&joinedTo=2026-09-01&activeFrom=2026-02-31&activeTo=yesterday",
    );
    expect(parseUsersFilter(params, ROLE_IDS)).toEqual({
      view: "staff",
      q: "",
      roles: ["admin", "role:r-clerk"],
      joined: { from: "2026-09-01", to: "2026-09-30" },
      active: { from: null, to: null },
      facets: {},
    });
  });

  it("ignores roles in the members group", () => {
    expect(parseUsersFilter(new URLSearchParams("view=members&role=admin"), ROLE_IDS).roles).toEqual([]);
  });

  it("accepts a server component's searchParams, repeated params included", () => {
    const parsed = parseUsersFilter({ role: ["editor", "admin"], q: ["first", "second"], view: undefined }, ROLE_IDS);
    expect(parsed.view).toBe("staff");
    expect(parsed.roles).toEqual(["admin", "editor"]);
    expect(parsed.q).toBe("first");
  });

  it("caps the query length", () => {
    expect(parseUsersFilter(new URLSearchParams({ q: "x".repeat(300) }), ROLE_IDS).q).toHaveLength(100);
  });
});

describe("usersFilterParams / hrefForUsersFilter", () => {
  const full: UsersFilter = {
    view: "staff",
    q: "alice",
    roles: ["admin", "role:r-clerk"],
    joined: { from: "2026-01-01", to: "2026-06-30" },
    active: { from: null, to: "2026-09-28" },
    facets: { "loyalty.tier": "has", "points.wallet": "missing" },
  };
  const FACET_KEYS = ["loyalty.tier", "points.wallet"];

  it("round-trips through parseUsersFilter", () => {
    expect(parseUsersFilter(usersFilterParams(full), ["r-clerk"], FACET_KEYS)).toEqual(full);
    const members = switchUsersView(full, "members");
    expect(parseUsersFilter(usersFilterParams(members), ["r-clerk"], FACET_KEYS)).toEqual(members);
  });

  it("writes facets by key in a stable order", () => {
    const a = usersFilterParams(filter({ facets: { "points.wallet": "missing", "loyalty.tier": "has" } }));
    expect(a.toString()).toBe("loyalty.tier=has&points.wallet=missing");
  });

  it("writes nothing for the default staff group with no conditions", () => {
    expect(usersFilterParams(emptyUsersFilter()).toString()).toBe("");
    expect(usersFilterParams(filter({ q: "   " })).toString()).toBe("");
  });

  it("keeps other params and the hash, replaces its own", () => {
    const href = hrefForUsersFilter(
      "https://cms.test/admin/users?view=members&q=old&keep=1#top",
      filter({ q: "new", roles: ["editor"] }),
    );
    const url = new URL(href, "https://cms.test");
    expect(url.pathname).toBe("/admin/users");
    expect(url.hash).toBe("#top");
    expect(url.searchParams.get("keep")).toBe("1");
    expect(url.searchParams.get("view")).toBeNull();
    expect(url.searchParams.get("q")).toBe("new");
    expect(url.searchParams.get("role")).toBe("editor");
  });

  it("replaces facet params too, including ones from a plugin that is gone", () => {
    const href = hrefForUsersFilter(
      "https://cms.test/admin/users?old.facet=has&loyalty.tier=missing&keep=1",
      filter({ facets: { "loyalty.tier": "has" } }),
    );
    const url = new URL(href, "https://cms.test");
    expect(url.searchParams.get("old.facet")).toBeNull();
    expect(url.searchParams.get("loyalty.tier")).toBe("has");
    expect(url.searchParams.get("keep")).toBe("1");
  });
});

describe("facets (1.60.0)", () => {
  // loyalty.tier:有值的人是 ming 與 admin;clerk 只有連結(沒有值),不算「有」。
  const WITH_FACETS = USERS.map((u) =>
    u.id === "ming" || u.id === "admin"
      ? { ...u, facets: { "loyalty.tier": { value: { badge: "Gold", lines: [] }, actions: [] } } }
      : u.id === "clerk"
        ? { ...u, facets: { "loyalty.tier": { actions: [{ label: "Enrol", href: "/admin/ext/loyalty/new" }] } } }
        : u,
  );
  const runFacets = (extra: Partial<UsersFilter>) => ids(filterUsers(WITH_FACETS, filter(extra), TZ));

  it("filters people with or without a value", () => {
    expect(runFacets({ facets: { "loyalty.tier": "has" } })).toEqual(["admin"]);
    expect(runFacets({ facets: { "loyalty.tier": "missing" } })).toEqual(["editor", "clerk"]);
    expect(runFacets({ view: "members", facets: { "loyalty.tier": "has" } })).toEqual(["ming"]);
    expect(runFacets({ view: "members", facets: { "loyalty.tier": "missing" } })).toEqual(["dana", "line"]);
  });

  it("combines with the other conditions", () => {
    expect(runFacets({ view: "members", q: "example", facets: { "loyalty.tier": "missing" } })).toEqual(["dana"]);
  });

  it("reads only facets the page knows, and only has / missing", () => {
    const params = new URLSearchParams("loyalty.tier=has&gone.facet=has&points.wallet=maybe");
    expect(parseUsersFilter(params, [], ["loyalty.tier", "points.wallet"]).facets).toEqual({ "loyalty.tier": "has" });
    expect(parseUsersFilter(params, []).facets).toEqual({});
  });

  it("counts as a filter, clears with the others, and follows the person across groups", () => {
    const f = filter({ facets: { "loyalty.tier": "has" } });
    expect(isUsersFiltered(f)).toBe(true);
    expect(switchUsersView(f, "members").facets).toEqual({ "loyalty.tier": "has" });
    expect(withFacetChoice(f, "loyalty.tier", null).facets).toEqual({});
    expect(withFacetChoice(f, "points.wallet", "missing").facets).toEqual({ "loyalty.tier": "has", "points.wallet": "missing" });
    // 不改原本的條件。
    expect(f.facets).toEqual({ "loyalty.tier": "has" });
  });
});

describe("switchUsersView / isUsersFiltered", () => {
  it("carries search and dates to the other group, drops roles for members", () => {
    const staff = filter({ q: "a", roles: ["admin"], joined: { from: "2026-09-01", to: null } });
    const members = switchUsersView(staff, "members");
    expect(members).toEqual({ ...staff, view: "members", roles: [] });
  });

  it("does not count a blank query as a search", () => {
    expect(isUsersFiltered(filter({ q: "  " }))).toBe(false);
    expect(isUsersFiltered(filter({ q: "a" }))).toBe(true);
    expect(isUsersFiltered(filter({ active: { from: null, to: "2026-09-01" } }))).toBe(true);
    expect(isUsersFiltered(filter({ view: "members" }))).toBe(false);
  });
});

describe("roleLabel", () => {
  const zh = getMessages("zh-Hant");
  const t = (key: keyof typeof zh) => zh[key];

  it("names presets and custom roles the way the table does", () => {
    const roles = [{ id: "r-clerk", name: "門市人員" }];
    expect(roleLabel({ role: "admin", staffRoleId: null }, t, roles)).toBe("管理員");
    expect(roleLabel({ role: "editor", staffRoleId: null }, t, roles)).toBe("工作人員");
    expect(roleLabel({ role: "guest", staffRoleId: "r-clerk" }, t, roles)).toBe("門市人員");
    // 角色剛被刪掉(staff_role_id 還沒清):退回訪客,跟權限一致。
    expect(roleLabel({ role: "guest", staffRoleId: "r-gone" }, t, roles)).toBe("訪客");
  });
});
