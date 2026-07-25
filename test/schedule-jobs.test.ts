import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { DeclarativeContentType, DeclarativeManifest } from "../src/ext/dx/manifest";
import type { Extension } from "../src/ext/types";

// B(docs/spec-declarative-notify-schedule.md)測試 6-8。
//
// buildScheduleJobs 本身是純函式(見 src/ext/dx/schedule-jobs.ts 檔頭註解),第一組
// describe 直接單元測試、無需任何 binding。第二組(deleteOlderThan 實際執行語意)
// binding-backed(miniflare D1),沿用 test/ext-jobs*.test.ts 的 mock 慣例:mock
// @/lib/cf 讓 db()/getDB() 打到 env.DB,mock @/ext/loader 讓 ext-jobs 引擎(jobs.ts,
// 本測試唯一驅動路徑,未修改)看到我們手動組的 rt.enabled。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const rtState = vi.hoisted(() => ({ enabled: [] as Extension[] }));
const hookState = vi.hoisted(() => ({ deleted: [] as unknown[] }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
  hooks.register("test", "content:deleted", (payload: unknown) => {
    hookState.deleted.push(payload);
  });
  const rt = {
    get enabled() {
      return rtState.enabled;
    },
    all: [] as Extension[],
    hooks,
    byId: (id: string) => rtState.enabled.find((e) => e.id === id),
    isCompatible: () => true,
  };
  return { getExtRuntime: async () => rt };
});

import { buildScheduleJobs } from "../src/ext/dx/schedule-jobs";
import { runDueJobs } from "../src/lib/jobs";
import { invalidateSettingsCache } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const CONTENTS_DDL =
  "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";
const SETTINGS_DDL =
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);";
const EXT_JOBS_DDL =
  "CREATE TABLE IF NOT EXISTS ext_jobs (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, job_id TEXT NOT NULL, kind TEXT NOT NULL, run_at INTEGER NOT NULL, payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', last_run INTEGER, last_error TEXT, created_at INTEGER NOT NULL);";

beforeAll(async () => {
  await d1().exec(CONTENTS_DDL);
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, locale UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec(SETTINGS_DDL);
  await d1().exec(EXT_JOBS_DDL);
});

beforeEach(async () => {
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM settings;");
  invalidateSettingsCache(); // 直接清表繞開寫入路徑,一併清 isolate settings 快取。
  await d1().exec("DELETE FROM ext_jobs;");
  rtState.enabled = [];
  hookState.deleted = [];
});

// ---- 6. pure mapping (no binding needed) ----

const submissionType: DeclarativeContentType = {
  name: "submission",
  fields: [{ key: "email", type: "text" }],
};

function makeManifest(
  schedule: DeclarativeManifest["schedule"],
): DeclarativeManifest {
  return {
    kind: "declarative",
    id: "acme",
    name: "Acme",
    version: "1.0.0",
    coreApi: "^1.11.0",
    contentTypes: [submissionType],
    schedule,
  };
}

describe("buildScheduleJobs — pure mapping (spec test 6)", () => {
  it("maps schedule[] items to Extension.jobs with matching id/every", () => {
    const manifest = makeManifest([
      {
        id: "purge-old",
        every: 1440,
        action: { op: "deleteOlderThan", contentType: "submission", days: 90 },
      },
    ]);
    const jobs = buildScheduleJobs(
      "acme",
      manifest,
      new Map([["submission", submissionType]]),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("purge-old");
    expect(jobs[0].every).toBe(1440);
    expect(typeof jobs[0].run).toBe("function");
  });

  it("skips a schedule item whose action.contentType is not declared", () => {
    const manifest = makeManifest([
      {
        id: "purge-ghost",
        every: 60,
        action: { op: "deleteOlderThan", contentType: "ghost", days: 30 },
      },
    ]);
    const jobs = buildScheduleJobs("acme", manifest, new Map()); // "ghost" 從未宣告
    expect(jobs).toHaveLength(0);
  });

  it("preserves declaration order and skips only the unmatched item", () => {
    const manifest = makeManifest([
      {
        id: "keep-a",
        every: 30,
        action: { op: "deleteOlderThan", contentType: "submission", days: 1 },
      },
      {
        id: "skip-b",
        every: 30,
        action: { op: "deleteOlderThan", contentType: "unknown", days: 1 },
      },
    ]);
    const jobs = buildScheduleJobs(
      "acme",
      manifest,
      new Map([["submission", submissionType]]),
    );
    expect(jobs.map((j) => j.id)).toEqual(["keep-a"]);
  });

  it("returns an empty array when manifest.schedule is absent", () => {
    const manifest = makeManifest(undefined);
    expect(buildScheduleJobs("acme", manifest, new Map())).toEqual([]);
  });
});

// ---- 7 & 8. deleteOlderThan execution semantics (binding-backed) ----

const EVERY_MIN = 60;
const EVERY_MS = EVERY_MIN * 60_000;
const DAYS = 90;
const MS_PER_DAY = 86_400_000;
const RETENTION_MS = DAYS * MS_PER_DAY;

function fakeScheduleExt(now: number): Extension {
  const manifest = makeManifest([
    {
      id: "purge-old",
      every: EVERY_MIN,
      action: { op: "deleteOlderThan", contentType: "submission", days: DAYS },
    },
  ]);
  const jobs = buildScheduleJobs(
    "acme",
    manifest,
    new Map([["submission", submissionType]]),
  );
  void now;
  return { id: "acme", name: "Acme", version: "1.0.0", coreApi: "^1.11.0", jobs };
}

async function insertContent(row: {
  id: string;
  type: string;
  createdAt: number;
}): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO contents (id, type, slug, status, data, created_at, updated_at) VALUES (?, ?, NULL, 'published', ?, ?, ?)",
    )
    .bind(row.id, row.type, JSON.stringify({ email: "x@example.com" }), row.createdAt, row.createdAt)
    .run();
}

async function existingIds(type: string): Promise<string[]> {
  const rows = await d1()
    .prepare("SELECT id FROM contents WHERE type = ? ORDER BY id")
    .bind(type)
    .all<{ id: string }>();
  return (rows.results ?? []).map((r) => r.id);
}

describe("ext-jobs (deleteOlderThan) — execution semantics (spec test 7)", () => {
  it("deletes only cutoff-crossing rows of the declared type; other types & recent rows untouched", async () => {
    const now = 100_000_000_000;
    rtState.enabled = [fakeScheduleExt(now)];

    // handler.run() 收到的 `now` 是實際到期時的 runDueJobs(now) 參數(即下面的
    // `due`),不是這裡的 reconcile `now` —— cutoff 必須以 `due` 為基準算,否則
    // (見 spec 註解)所有測資都會落在 shifted cutoff 之後被誤刪。
    const due = now + EVERY_MS;
    const cutoff = due - RETENTION_MS;
    await insertContent({ id: "old-1", type: "acme.submission", createdAt: cutoff - 1 });
    await insertContent({ id: "boundary", type: "acme.submission", createdAt: cutoff }); // not < cutoff, kept
    await insertContent({ id: "recent-1", type: "acme.submission", createdAt: cutoff + 1 });
    await insertContent({ id: "other-old", type: "acme.other", createdAt: cutoff - 1 }); // 他 type,不動

    await runDueJobs(now); // reconcile only, first run_at = now + EVERY_MS (not due)
    expect(await existingIds("acme.submission")).toEqual([
      "boundary",
      "old-1",
      "recent-1",
    ]);

    const reports = await runDueJobs(due); // due now, deleteOlderThan runs
    const extJobsReport = reports.find((r) => r.id === "ext-jobs")!;
    expect(extJobsReport.ok).toBe(true);
    expect(extJobsReport.processed).toBe(1); // 一個 handler 執行(不是刪除筆數)

    expect(await existingIds("acme.submission")).toEqual(["boundary", "recent-1"]);
    expect(await existingIds("acme.other")).toEqual(["other-old"]); // 他 type 老列不動
  });

  it("LIMIT 50 boundary: 51 expired rows leave exactly 1 after one due run", async () => {
    const now = 200_000_000_000;
    rtState.enabled = [fakeScheduleExt(now)];
    const due = now + EVERY_MS; // 見上一個 it() 的註解:cutoff 須以執行時的 now(=due)為準
    const cutoff = due - RETENTION_MS;

    for (let i = 0; i < 51; i++) {
      await insertContent({
        id: `old-${i}`,
        type: "acme.submission",
        createdAt: cutoff - 1000 - i,
      });
    }
    await runDueJobs(now); // reconcile
    await runDueJobs(due); // execute: deletes 50, 1 remains
    expect((await existingIds("acme.submission")).length).toBe(1);
  });
});

describe("ext-jobs (deleteOlderThan) — provider.delete side effects (spec test 8)", () => {
  it("fires content:deleted through the provider and removes the FTS row", async () => {
    const now = 300_000_000_000;
    rtState.enabled = [fakeScheduleExt(now)];
    const due = now + EVERY_MS;
    const cutoff = due - RETENTION_MS;
    await insertContent({ id: "expired-1", type: "acme.submission", createdAt: cutoff - 1 });

    await runDueJobs(now); // reconcile
    await runDueJobs(due); // execute

    expect(await existingIds("acme.submission")).toEqual([]);
    expect(hookState.deleted).toEqual([
      { type: "acme.submission", id: "expired-1", data: expect.anything() },
    ]);

    const ftsRow = await d1()
      .prepare("SELECT count(*) AS n FROM content_fts WHERE content_id = ?")
      .bind("expired-1")
      .first<{ n: number }>();
    expect(ftsRow?.n).toBe(0);
  });
});
