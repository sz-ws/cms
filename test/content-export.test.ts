import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 內容匯出引擎(src/lib/content-export.ts)的 binding-backed 整合測試(miniflare D1)。
// 重點:輸出形狀、keyset 分頁在「會撐爆單次查詢」的資料量下仍正確、以及
// secret 絕不外流的白名單邏輯。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// secretKeySetAsync() 會透過 loader 讀已啟用 extension 的 settings 宣告。
const extState = vi.hoisted(() => ({
  enabled: [] as { id: string; settings?: { key: string; secret?: boolean }[] }[],
  throws: false,
}));
vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => {
    if (extState.throws) throw new Error("runtime unavailable");
    return { enabled: extState.enabled, all: [], byId: () => undefined };
  },
}));

// secretKeySetAsync 的 runtime 判定是紅線的第二道關卡;用 partial mock 讓測試能
// 直接操縱它(ESM export 無法 spyOn)。override=null 時走真實實作(吃上面的 loader mock)。
const secretState = vi.hoisted(() => ({ override: null as Set<string> | null }));
vi.mock("@/lib/settings", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/settings")>();
  return {
    ...actual,
    secretKeySetAsync: async () =>
      secretState.override ?? (await actual.secretKeySetAsync()),
  };
});

import {
  EXPORT_FORMAT,
  MAX_ENTRIES,
  EXPORTABLE_SETTING_KEYS,
  collectExportableSettings,
  exportRecords,
  ndjsonStream,
  type ExportRecord,
  type EndRecord,
  type EntryRecord,
  type MetaRecord,
  type SettingRecord,
} from "../src/lib/content-export";
import { CORE_SETTINGS } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

// 本檔刻意持有自己的 contents DDL,而且每個 test 前 DROP + CREATE:匯出的輸出形狀
// 就是這裡要釘死的東西,不能隨著別人加欄位而漂移。「新欄位會怎樣」由專屬的
// ALTER TABLE 測試(見 EntryRecord.extra)明確覆蓋,而不是靠意外撞到。
const CONTENTS_DDL =
  "CREATE TABLE contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";
const SETTINGS_DDL =
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);";

const META: MetaRecord = {
  kind: "meta",
  format: EXPORT_FORMAT,
  exportedAt: 1_700_000_000_000,
  includes: ["setting", "media", "entry"],
  excludes: [],
  types: [],
  filter: { type: null, after: null },
  limits: { maxEntries: MAX_ENTRIES, maxMediaObjects: 3000 },
};

/** id 補零排序才和 keyset 的 `id >` 字典序一致(真實 nanoid 亦為固定長度)。 */
const idAt = (n: number) => `e${String(n).padStart(6, "0")}`;

async function seedEntries(count: number, type = "blog.post"): Promise<void> {
  const now = 1_700_000_000_000;
  for (let start = 0; start < count; start += 100) {
    const batch = [];
    for (let i = start; i < Math.min(start + 100, count); i++) {
      batch.push(
        d1()
          .prepare(
            "INSERT INTO contents (id, type, slug, status, publish_at, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
          )
          .bind(
            idAt(i),
            type,
            `slug-${i}`,
            i % 2 === 0 ? "published" : "draft",
            null,
            JSON.stringify({ title: `Post ${i}`, body: "x".repeat(50) }),
            now + i,
            now + i,
          ),
      );
    }
    await d1().batch(batch);
  }
}

async function collect(
  opts: Partial<Parameters<typeof exportRecords>[0]> = {},
): Promise<ExportRecord[]> {
  const out: ExportRecord[] = [];
  for await (const r of exportRecords({
    d1: d1(),
    r2: undefined,
    meta: META,
    settings: [],
    type: null,
    after: null,
    mediaCursor: null,
    ...opts,
  })) {
    out.push(r);
  }
  return out;
}

const entriesOf = (rs: ExportRecord[]) =>
  rs.filter((r): r is EntryRecord => r.kind === "entry");
const endOf = (rs: ExportRecord[]) =>
  rs.find((r): r is EndRecord => r.kind === "end")!;

beforeAll(async () => {
  await d1().exec(SETTINGS_DDL);
});

beforeEach(async () => {
  await d1().exec("DROP TABLE IF EXISTS contents");
  await d1().exec(CONTENTS_DDL);
  await d1().exec("DELETE FROM settings");
  extState.enabled = [];
  extState.throws = false;
  secretState.override = null;
});

describe("export record shape", () => {
  it("emits meta first and end last, with exact entry fields", async () => {
    await seedEntries(3);
    const records = await collect();

    expect(records[0].kind).toBe("meta");
    expect((records[0] as MetaRecord).format).toBe(EXPORT_FORMAT);
    expect(records[records.length - 1].kind).toBe("end");

    const entries = entriesOf(records);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      kind: "entry",
      type: "blog.post",
      id: idAt(0),
      slug: "slug-0",
      status: "published",
      publishAt: null,
      data: { title: "Post 0", body: "x".repeat(50) },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    // 沒有未知欄位時不生 extra 鍵。
    expect("extra" in entries[0]).toBe(false);

    expect(endOf(records)).toEqual({
      kind: "end",
      counts: { settings: 0, media: 0, entries: 3 },
      truncated: { media: false, entries: false },
      resume: null,
    });
  });

  it("filters to a single content type", async () => {
    await seedEntries(2, "blog.post");
    await d1()
      .prepare(
        "INSERT INTO contents (id, type, slug, status, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind("z1", "shop.product", "p", "published", "{}", 1, 1)
      .run();

    const all = entriesOf(await collect());
    expect(all).toHaveLength(3);

    const only = entriesOf(await collect({ type: "shop.product" }));
    expect(only).toHaveLength(1);
    expect(only[0].type).toBe("shop.product");
  });

  it("carries columns this format does not know about instead of dropping them", async () => {
    // 未來的 migration 加了 ROW 欄位(例如 locale),沒人回頭改匯出程式 —— 資料
    // 仍必須出得去,只是落在 extra 裡。這是「拿得回全部資料」的最後一道保險。
    await d1().exec("ALTER TABLE contents ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'");
    await d1()
      .prepare(
        "INSERT INTO contents (id, type, slug, status, data, created_at, updated_at, locale) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind("n1", "blog.post", "s", "draft", "{}", 1, 1, "zh-Hant")
      .run();

    const entries = entriesOf(await collect());
    expect(entries[0].extra).toEqual({ locale: "zh-Hant" });
    // 已認得的欄位不會被重複塞進 extra。
    expect(Object.keys(entries[0].extra!)).toEqual(["locale"]);
  });

  it("survives an unparseable data column instead of failing the export", async () => {
    await d1()
      .prepare(
        "INSERT INTO contents (id, type, slug, status, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind("bad1", "blog.post", null, "draft", "{not json", 1, 1)
      .run();

    const entries = entriesOf(await collect());
    expect(entries[0].data).toBeNull();
    expect(entries[0].dataRaw).toBe("{not json");
    expect(endOf(await collect()).counts.entries).toBe(1);
  });
});

describe("streaming / pagination at a size that would blow up a single query", () => {
  // CONTENT_BATCH = 250。1,200 筆 → 至少 5 個 keyset 批次,證明分頁真的在走,
  // 而且沒有任何一個時刻把全部列讀進記憶體。
  it("streams 1200 entries across keyset batches with no duplicates or gaps", async () => {
    await seedEntries(1200);
    const entries = entriesOf(await collect());

    expect(entries).toHaveLength(1200);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(1200); // 無重複
    expect(ids).toEqual([...ids].sort()); // keyset 序穩定
    expect(ids[0]).toBe(idAt(0));
    expect(ids[1199]).toBe(idAt(1199));
    expect(endOf(await collect()).truncated.entries).toBe(false);
  });

  it("resumes from `after` without re-emitting earlier entries", async () => {
    await seedEntries(600);
    const first = entriesOf(await collect()).slice(0, 300);
    const resumed = entriesOf(await collect({ after: first[299].id }));

    expect(resumed).toHaveLength(300);
    expect(resumed[0].id).toBe(idAt(300));
    const overlap = new Set(first.map((e) => e.id));
    expect(resumed.some((e) => overlap.has(e.id))).toBe(false);
  });

  it("marks a mid-stream entry read failure incomplete and returns the last emitted cursor", async () => {
    await seedEntries(300);
    let prepares = 0;
    const brokenAfterFirstPage = {
      prepare(sql: string) {
        prepares++;
        if (prepares === 2) throw new Error("D1 subrequest limit reached");
        return d1().prepare(sql);
      },
    } as unknown as D1Database;

    const records = await collect({ d1: brokenAfterFirstPage });
    const end = endOf(records);

    expect(records.at(-1)?.kind).toBe("end");
    expect(records).toContainEqual({
      kind: "warning",
      phase: "entry",
      message: "D1 subrequest limit reached",
    });
    expect(entriesOf(records)).toHaveLength(250);
    // warning 不是完成訊號：consumer 只能把 truncated 全 false 視為完整 backup。
    expect(end.truncated).toEqual({ media: false, entries: true });
    expect(end.resume).toEqual({ after: idAt(249) });
  });

  it("never buffers the whole result set: ndjsonStream pulls lazily", async () => {
    await seedEntries(1200);
    // 只讀第一個 chunk 就取消,generator 必須停在早期批次而非跑完 1200 筆。
    let pulled = 0;
    const counting = (async function* () {
      for await (const r of exportRecords({
        d1: d1(),
        r2: undefined,
        meta: META,
        settings: [],
        type: null,
        after: null,
        mediaCursor: null,
      })) {
        pulled++;
        yield r;
      }
    })();

    const reader = ndjsonStream(counting).getReader();
    const { value } = await reader.read();
    await reader.cancel();

    expect(value).toBeInstanceOf(Uint8Array);
    // 第一個 chunk 目標 64KB;一筆 entry ≈ 200 bytes → 遠少於 1200 筆。
    expect(pulled).toBeLessThan(1200);
    expect(pulled).toBeGreaterThan(0);
  });

  it("emits valid NDJSON: every line parses on its own", async () => {
    await seedEntries(400);
    const res = new Response(
      ndjsonStream(
        exportRecords({
          d1: d1(),
          r2: undefined,
          meta: META,
          settings: [],
          type: null,
          after: null,
          mediaCursor: null,
        }),
      ),
    );
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.length > 0);

    expect(lines).toHaveLength(402); // meta + 400 entries + end
    const parsed = lines.map((l) => JSON.parse(l) as ExportRecord);
    expect(parsed[0].kind).toBe("meta");
    expect(parsed[401].kind).toBe("end");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("media manifest", () => {
  function fakeR2(pages: { objects: unknown[]; truncated: boolean; cursor?: string }[]) {
    let call = 0;
    return {
      list: async () => pages[Math.min(call++, pages.length - 1)],
    } as unknown as R2Bucket;
  }

  it("emits key/size/contentType/alt/url and no file bytes", async () => {
    const r2 = fakeR2([
      {
        objects: [
          {
            key: "core/2026/07/abc.png",
            size: 1234,
            httpMetadata: { contentType: "image/png" },
            customMetadata: { alt: "a red bike" },
          },
          { key: "core/2026/07/def.bin", size: 7, httpMetadata: {}, customMetadata: {} },
        ],
        truncated: false,
      },
    ]);
    const records = await collect({ r2 });
    const media = records.filter((r) => r.kind === "media");

    expect(media).toEqual([
      {
        kind: "media",
        key: "core/2026/07/abc.png",
        size: 1234,
        contentType: "image/png",
        alt: "a red bike",
        url: "/api/files/core/2026/07/abc.png",
      },
      {
        kind: "media",
        key: "core/2026/07/def.bin",
        size: 7,
        contentType: "application/octet-stream",
        url: "/api/files/core/2026/07/def.bin",
      },
    ]);
    expect(JSON.stringify(media)).not.toContain("body");
  });

  it("caps media enumeration and hands back a resume cursor", async () => {
    const page = {
      objects: Array.from({ length: 100 }, (_, i) => ({
        key: `core/${i}.png`,
        size: 1,
        httpMetadata: { contentType: "image/png" },
      })),
      truncated: true,
      cursor: "next-page",
    };
    const records = await collect({ r2: fakeR2([page]) });
    const end = endOf(records);

    expect(end.counts.media).toBe(3000); // 30 頁 × 100
    expect(end.truncated.media).toBe(true);
    expect(end.resume?.mediaCursor).toBe("next-page");
  });

  it("marks a failed R2 listing incomplete while still reaching `end`", async () => {
    await seedEntries(2);
    const broken = {
      list: async () => {
        throw new Error("r2 down");
      },
    } as unknown as R2Bucket;
    const records = await collect({ r2: broken });

    expect(records.some((r) => r.kind === "warning")).toBe(true);
    expect(entriesOf(records)).toHaveLength(2);
    expect(endOf(records).counts.entries).toBe(2);
    expect(endOf(records).truncated.media).toBe(true);
  });
});

describe("secret handling (absolute rule: no decrypted secret ever leaves)", () => {
  async function putSetting(key: string, value: unknown) {
    await d1()
      .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .bind(key, JSON.stringify(value), 1)
      .run();
  }

  it("exports only the allowlisted non-secret core keys", async () => {
    await putSetting("core.siteTitle", "Acme");
    await putSetting("core.seo.rss", true);
    await putSetting("core.apiSecret", "ENCRYPTED-BLOB");
    await putSetting("core.resendApiKey", "ENCRYPTED-BLOB");
    await putSetting("core.registryTokens", "ENCRYPTED-BLOB");
    await putSetting("core.ai.apiKey", "ENCRYPTED-BLOB");
    await putSetting("core.demoCallbackSecret", "ENCRYPTED-BLOB");

    const out = await collectExportableSettings();
    const keys = out.map((s) => s.key);

    expect(keys).toEqual(["core.siteTitle", "core.seo.rss"]);
    expect(JSON.stringify(out)).not.toContain("ENCRYPTED-BLOB");
    // 遮罩佔位符也不該出現 —— 決策是「不放」,不是「放個 •••」。
    expect(JSON.stringify(out)).not.toContain("•••");
    expect(out.find((s) => s.key === "core.siteTitle")?.value).toBe("Acme");
  });

  it("never exports ext.* settings, secret or not", async () => {
    extState.enabled = [
      { id: "blog", settings: [{ key: "apiKey", secret: true }, { key: "perPage" }] },
    ];
    await putSetting("ext.blog.apiKey", "ENCRYPTED-BLOB");
    await putSetting("ext.blog.perPage", 10);

    const keys = (await collectExportableSettings()).map((s) => s.key);
    expect(keys.some((k) => k.startsWith("ext."))).toBe(false);
  });

  it("drops an allowlisted key the moment it is declared secret at runtime", async () => {
    await putSetting("core.siteTitle", "Acme");
    await putSetting("core.seo.rss", true);
    // 模擬「哪天 core.siteTitle 被標成 secret」:runtime secret 集合說了算,
    // 白名單不會因為沒人回來改就繼續放行。
    secretState.override = new Set(["core.siteTitle"]);

    const keys = (await collectExportableSettings()).map((s) => s.key);
    expect(keys).not.toContain("core.siteTitle");
    expect(keys).toContain("core.seo.rss");
  });

  it("exports nothing when the secret-key set cannot be computed (fail closed)", async () => {
    await putSetting("core.siteTitle", "Acme");
    extState.throws = true;
    expect(await collectExportableSettings()).toEqual([]);
  });

  it("allowlist contains no key that CORE_SETTINGS marks secret", () => {
    const secretKeys = new Set(
      CORE_SETTINGS.filter((f) => f.secret).map((f) => f.key),
    );
    for (const key of EXPORTABLE_SETTING_KEYS) {
      expect(secretKeys.has(key)).toBe(false);
    }
  });

  it("passes allowlisted settings straight through into the stream", async () => {
    const settings: SettingRecord[] = [
      { kind: "setting", key: "core.siteTitle", value: "Acme" },
    ];
    const records = await collect({ settings });
    expect(records[1]).toEqual({ kind: "setting", key: "core.siteTitle", value: "Acme" });
    expect(endOf(records).counts.settings).toBe(1);
  });
});
