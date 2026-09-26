import { describe, it, expect, vi, afterEach } from "vitest";

// 1.56.0 上新通知:解析、挑選、來源開關的 noticesSince,以及 registry client 的兩件事
// (requestedAt、只有打開通知的來源才解析 notices)。純函式;registry 以 stub 的 fetch 代替。

const sourcesState = vi.hoisted(() => ({ sources: [] as unknown[] }));
vi.mock("@/lib/settings", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/settings")>()),
  getSetting: async () => sourcesState.sources,
  getRegistryTokenMap: async () => ({}),
}));

import { parseNotices, pickNotice, seenKey, type RegistryNotice } from "../src/lib/registry-notices";
import { fetchRegistryIndex } from "../src/lib/registry-client";
import { stampNoticesSince } from "../src/lib/settings";

const ENTRIES = [
  { id: "session-replay", name: "工作階段錄影", version: "0.1.0", banner: "banner.png" },
  { id: "reviews", name: "評論", version: "1.0.0" },
];

const notice = (extra: Record<string, unknown> = {}) => ({
  id: "2026-10-session-replay",
  title: "新服務:工作階段錄影",
  body: "看訪客在頁面上怎麼捲動、點了哪裡、卡在哪一步。",
  extension: "session-replay",
  publishedAt: "2026-10-01",
  expiresAt: "2026-11-01",
  ...extra,
});

const parse = (...list: unknown[]) => parseNotices({ notices: list }, ENTRIES);

describe("parsing notices", () => {
  it("a valid notice carries the plugin's name and banner from the same index", () => {
    expect(parse(notice())).toEqual([
      {
        id: "2026-10-session-replay",
        title: "新服務:工作階段錄影",
        body: "看訪客在頁面上怎麼捲動、點了哪裡、卡在哪一步。",
        extension: "session-replay",
        extensionName: "工作階段錄影",
        banner: "banner.png",
        version: "0.1.0",
        publishedAt: "2026-10-01",
        expiresAt: "2026-11-01",
      },
    ]);
  });

  it("a notice about a plugin that is not in this index is dropped", () => {
    expect(parse(notice({ extension: "from-another-registry" }))).toEqual([]);
    expect(parse(notice({ extension: undefined }))).toEqual([]);
  });

  it("an outside url is never read", () => {
    const [n] = parse(notice({ url: "https://phish.example.com/renew" }));
    expect(JSON.stringify(n)).not.toContain("phish");
  });

  it("drops notices with a bad id, a long title or body, or bad dates", () => {
    const bad = [
      notice({ id: "Has Spaces" }),
      notice({ id: "x".repeat(65) }),
      notice({ title: "字".repeat(41) }),
      notice({ title: "" }),
      notice({ title: undefined }),
      notice({ body: "字".repeat(201) }),
      notice({ body: { en: "ok", "zh-Hant": "字".repeat(201) } }),
      notice({ publishedAt: "October 1st" }),
      notice({ publishedAt: undefined }),
      notice({ expiresAt: "2026-13-45" }),
      "not an object",
    ];
    for (const raw of bad) expect(parse(raw)).toEqual([]);
  });

  it("text is cleaned before counting; localized text is kept per language", () => {
    const [n] = parse(notice({ title: { en: "\u001b[2JNew", "zh-Hant": "新服務‮" }, body: undefined }));
    expect(n.title).toEqual({ en: "New", "zh-Hant": "新服務" });
    expect(n.body).toBeUndefined();
  });

  it("the same id twice keeps the first; at most 20 are read", () => {
    const list = parse(notice({ title: "first" }), notice({ title: "second" }));
    expect(list.map((n) => n.title)).toEqual(["first"]);
    const many = Array.from({ length: 30 }, (_, i) => notice({ id: `n-${i}` }));
    expect(parseNotices({ notices: many }, ENTRIES)).toHaveLength(20);
  });

  it("no notices, or not an array, is nothing", () => {
    expect(parseNotices({}, ENTRIES)).toEqual([]);
    expect(parseNotices({ notices: {} }, ENTRIES)).toEqual([]);
    expect(parseNotices(null, ENTRIES)).toEqual([]);
  });
});

const SOURCE = "https://registry.example.com";
const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);

function stored(extra: Partial<RegistryNotice> = {}): RegistryNotice {
  return {
    id: "a",
    title: "A",
    extension: "session-replay",
    extensionName: "工作階段錄影",
    version: "0.1.0",
    publishedAt: "2026-10-01",
    ...extra,
  };
}

describe("picking the one to show", () => {
  const base = {
    sources: [{ source: SOURCE, since: "2026-09-20T00:00:00Z", notices: [stored()] }],
    seen: new Set<string>(),
    lastSeenAt: null,
    now: at("2026-10-02T00:00:00Z"),
  };

  it("an unseen notice inside its dates is shown", () => {
    expect(pickNotice(base)?.id).toBe("a");
    expect(pickNotice(base)?.source).toBe(SOURCE);
  });

  it("nothing published before the switch was turned on", () => {
    expect(pickNotice({ ...base, sources: [{ ...base.sources[0], since: "2026-10-01T08:00:00Z" }] })).toBeNull();
    expect(pickNotice({ ...base, sources: [{ ...base.sources[0], since: undefined }] })).toBeNull();
  });

  it("not before publishedAt, not after expiresAt", () => {
    expect(pickNotice({ ...base, now: at("2026-09-30T00:00:00Z") })).toBeNull();
    const expiring = [{ ...base.sources[0], notices: [stored({ expiresAt: "2026-10-05" })] }];
    expect(pickNotice({ ...base, sources: expiring, now: at("2026-10-04T23:00:00Z") })?.id).toBe("a");
    expect(pickNotice({ ...base, sources: expiring, now: at("2026-10-05T00:00:00Z") })).toBeNull();
  });

  it("one this admin has seen is not shown again", () => {
    expect(pickNotice({ ...base, seen: new Set([seenKey(SOURCE, "a")]) })).toBeNull();
    // 看過的是另一個來源的同名通知,不算。
    expect(pickNotice({ ...base, seen: new Set([seenKey("https://other.example.com", "a")]) })?.id).toBe("a");
  });

  it("at most one a day: ten notices take ten days", () => {
    const ten = [{ ...base.sources[0], notices: Array.from({ length: 10 }, (_, i) => stored({ id: `n-${i}` })) }];
    expect(pickNotice({ ...base, sources: ten, lastSeenAt: base.now - DAY + 60_000 })).toBeNull();
    expect(pickNotice({ ...base, sources: ten, lastSeenAt: base.now - DAY })).not.toBeNull();
  });

  it("the newest one first", () => {
    const two = [
      { ...base.sources[0], notices: [stored({ id: "old", publishedAt: "2026-09-25" }), stored({ id: "new", publishedAt: "2026-10-01" })] },
    ];
    expect(pickNotice({ ...base, sources: two })?.id).toBe("new");
    expect(pickNotice({ ...base, sources: two, seen: new Set([seenKey(SOURCE, "new")]) })?.id).toBe("old");
  });
});

describe("turning notices on for a source", () => {
  const now = "2026-10-02T00:00:00.000Z";

  it("off by default: nothing is stored", () => {
    expect(stampNoticesSince({ url: SOURCE }, [], now)).toEqual({ url: SOURCE });
    expect(stampNoticesSince({ url: SOURCE, notices: false, noticesSince: "x" }, [], now)).toEqual({ url: SOURCE });
  });

  it("switching on stamps the time; the browser cannot pick it", () => {
    expect(stampNoticesSince({ url: SOURCE, notices: true, noticesSince: "2000-01-01T00:00:00Z" }, [], now)).toEqual({
      url: SOURCE,
      notices: true,
      noticesSince: now,
    });
  });

  it("saving again keeps the first time; off and on again starts over", () => {
    const before = [{ url: SOURCE, notices: true, noticesSince: "2026-09-01T00:00:00.000Z" }];
    expect(stampNoticesSince({ url: SOURCE, notices: true }, before, now).noticesSince).toBe("2026-09-01T00:00:00.000Z");
    const wasOff = [{ url: SOURCE, noticesSince: "2026-09-01T00:00:00.000Z" }];
    expect(stampNoticesSince({ url: SOURCE, notices: true }, wasOff, now).noticesSince).toBe(now);
  });
});

// ── registry client ────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals();
});

function serveIndex(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })),
  );
}

const entry = (extra: Record<string, unknown> = {}) => ({
  id: "session-replay",
  kind: "declarative",
  name: "工作階段錄影",
  version: "0.1.0",
  coreApi: "^1.0.0",
  ...extra,
});

describe("registry client", () => {
  it("requestedAt is kept only with access: requested, and only as an ISO date", async () => {
    sourcesState.sources = [{ url: "https://requested.example.com" }];
    serveIndex({
      extensions: [
        entry({ access: "requested", requestedAt: "2026-09-23" }),
        entry({ id: "a-bad-date", access: "requested", requestedAt: "9/23" }),
        entry({ id: "not-requested", access: "locked", requestedAt: "2026-09-23" }),
      ],
    });
    const { entries } = await fetchRegistryIndex();
    expect(entries.map((e) => [e.id, e.requestedAt])).toEqual([
      ["session-replay", "2026-09-23"],
      ["a-bad-date", undefined],
      ["not-requested", undefined],
    ]);
  });

  it("notices are read only for sources that turned them on", async () => {
    const off = "https://notices-off.example.com";
    const on = "https://notices-on.example.com";
    sourcesState.sources = [{ url: off }, { url: on, notices: true, noticesSince: "2026-09-01T00:00:00Z" }];
    serveIndex({ extensions: [entry()], notices: [notice()] });
    const { notices } = await fetchRegistryIndex();
    expect(notices).toHaveLength(1);
    expect(notices[0].source).toBe(on);
    expect(notices[0].notices.map((n) => n.id)).toEqual(["2026-10-session-replay"]);
  });
});
