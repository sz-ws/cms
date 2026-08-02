import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// core jobs surface + scheduled publishing 的 binding-backed 整合測試(miniflare D1)。
// 同既有測試:mock @/lib/cf 讓 db()/getDB() 直接打到 cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// requireAuth 由測試控制(pool-workers 無 request-scoped cookies);語意與真實一致。
const authState = vi.hoisted(() => ({
  user: null as
    | null
    | { id: string; email: string; name: string; role: "admin" | "editor" },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async (role?: "admin") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (role && authState.user.role !== role)
        throw new actual.AuthError(403);
      return authState.user;
    },
  };
});

// @/ext/loader 全 mock:提供可控 runtime(空 enabled + 帶 spy handler 的 HookBus)。
// publish-due 透過 getExtRuntime().hooks 觸發 content:updated;setSettings 亦透過它取
// secretKeys / 分派 settings:saved(空 handler)。避免依賴 extensions 表與真實 registry。
const hookState = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
  hooks.register("test", "content:updated", (payload: unknown) => {
    hookState.calls.push(payload);
  });
  const rt = {
    enabled: [] as unknown[],
    all: [] as unknown[],
    hooks,
    byId: () => undefined,
    isCompatible: () => true,
  };
  return { getExtRuntime: async () => rt };
});

import { runDueJobs, maybeRunJobs } from "../src/lib/jobs";
import { CoreContentProvider } from "../src/ext/dx/content-provider";
import { HookBus } from "../src/ext/hooks";
import {
  getSetting,
  setSettings,
  invalidateSettingsCache,
} from "../src/lib/settings";
import { POST } from "../src/app/api/jobs/run/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";

const ADMIN = {
  id: "u-admin",
  email: "admin@test.com",
  name: "Admin",
  role: "admin" as const,
};
const EDITOR = {
  id: "u-editor",
  email: "editor@test.com",
  name: "Editor",
  role: "editor" as const,
};

const CONTENTS_DDL =
  "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";

// ext-jobs core job(spec-extension-jobs.md)現與 publish-due 併入同一個 CORE_JOBS
// 迭代;這裡的 rt.enabled 恆空,故 ext-jobs 每次都是 reconcile 0 筆 + 無到期列的
// no-op(ok:true, processed:0)。仍需要這張表存在,否則其 reconcile SELECT 會
// throw,把 no-op 變成 ok:false,汙染下面每個 reports 的精確比對。
const EXT_JOBS_DDL =
  "CREATE TABLE IF NOT EXISTS ext_jobs (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, job_id TEXT NOT NULL, kind TEXT NOT NULL, run_at INTEGER NOT NULL, payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', last_run INTEGER, last_error TEXT, created_at INTEGER NOT NULL);";

// publish-due 的 WHERE 帶了 `NOT EXISTS (SELECT 1 FROM content_submissions …)`
// —— 公開表單的收件列永遠不得被排程發佈碰到(見 src/lib/jobs.ts 該處註解與
// migrations/0014)。表不存在會讓那句 SELECT throw,把 publish-due 變成 ok:false,
// 汙染下面每個 reports 的精確比對(理由同上面 EXT_JOBS_DDL)。
// 「收件列真的不會被發佈」的正面斷言住在 test/submissions.test.ts。
const CONTENT_SUBMISSIONS_DDL =
  "CREATE TABLE IF NOT EXISTS content_submissions (content_id TEXT PRIMARY KEY, type TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'unread', replied_at INTEGER, updated_at INTEGER NOT NULL);";

/** publish-due 之後,恆為 no-op 的 ext-jobs 報告(此檔的 rt.enabled 恆空)。 */
const EXT_JOBS_NOOP = { id: "ext-jobs", ok: true, processed: 0 };

// license-checkin(src/licensing/):不管本機 src/licensing/verify.local.ts
// 是哪個版本(真實商業檔、或此檔不存在時 build 自動產生的 community stub,
// 見 scripts/ensure-licensing-stub.mjs),兩者的 checkIn() 都必須 fail-fast
// 且不對外發任何請求 —— 但兩者的 detail 文字字面上不同("not_configured" vs
// "Community edition — ..."),故只斷言 id/ok,不鎖死 detail 字串,讓測試在
// 任一本機檔案狀態下都能通過(這正是這個機制存在的意義:OSS clone 也要能
// 綠燈跑測試)。
const LICENSE_CHECKIN_NOOP = expect.objectContaining({
  id: "license-checkin",
  ok: true,
});

// storage-probe(migrations/0015_storage_history.sql):寫一列 size_after 快照。
// 表不存在會 throw → ok:false,汙染下面每個 reports 的精確比對(理由同
// EXT_JOBS_DDL),所以這裡建表。detail 帶的是真實資料庫大小,**會隨這個檔案
// 每次 insert/delete 而漂移**,所以只能模糊比對(同 LICENSE_CHECKIN_NOOP)。
// 行為面的正面斷言住在 test/storage-probe.test.ts。
const STORAGE_HISTORY_DDL =
  "CREATE TABLE IF NOT EXISTS storage_history (at INTEGER PRIMARY KEY, size_after INTEGER NOT NULL, rows_read INTEGER, note TEXT);";

/** storage-probe 的報告:只保證 id 與 ok,大小數字不可預測。 */
const STORAGE_PROBE_EMPTY = expect.objectContaining({
  id: "storage-probe",
  ok: true,
});

beforeAll(async () => {
  await d1().exec(CONTENTS_DDL);
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, locale UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(EXT_JOBS_DDL);
  await d1().exec(CONTENT_SUBMISSIONS_DDL);
  await d1().exec(STORAGE_HISTORY_DDL);
});

beforeEach(async () => {
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM settings;");
  invalidateSettingsCache(); // 直接清表繞開寫入路徑,一併清 isolate settings 快取。
  await d1().exec("DELETE FROM ext_jobs;");
  await d1().exec("DELETE FROM storage_history;");
  hookState.calls = [];
  authState.user = ADMIN;
});

async function insertContent(opts: {
  id: string;
  type?: string;
  status: "draft" | "published";
  publishAt: number | null;
  data: Record<string, unknown>;
  updatedAt?: number;
}): Promise<void> {
  const now = opts.updatedAt ?? 1000;
  await d1()
    .prepare(
      "INSERT INTO contents (id, type, slug, status, publish_at, data, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
    )
    .bind(
      opts.id,
      opts.type ?? "blog.post",
      opts.status,
      opts.publishAt,
      JSON.stringify(opts.data),
      now,
      now,
    )
    .run();
}

interface Row {
  status: string;
  publish_at: number | null;
  updated_at: number;
  data: string;
}
function readRow(id: string): Promise<Row | null> {
  return d1()
    .prepare(
      "SELECT status, publish_at, updated_at, data FROM contents WHERE id = ?",
    )
    .bind(id)
    .first<Row>();
}

function ftsCount(id: string): Promise<{ n: number } | null> {
  return d1()
    .prepare("SELECT count(*) AS n FROM content_fts WHERE content_id = ?")
    .bind(id)
    .first<{ n: number }>();
}

// ---- publish-due job ----

describe("runDueJobs — publish-due", () => {
  it("flips a due draft to published, clears publish_at, stamps updated_at", async () => {
    const now = 5_000_000;
    await insertContent({
      id: "due1",
      status: "draft",
      publishAt: now - 1000,
      data: { title: "Scheduled post" },
      updatedAt: 1000,
    });

    const reports = await runDueJobs(now);
    expect(reports).toEqual([
      { id: "publish-due", ok: true, processed: 1 },
      EXT_JOBS_NOOP,
      LICENSE_CHECKIN_NOOP,
      STORAGE_PROBE_EMPTY,
    ]);

    const row = await readRow("due1");
    expect(row?.status).toBe("published");
    expect(row?.publish_at).toBeNull();
    expect(row?.updated_at).toBe(now);
  });

  it("fires content:updated with the provider payload shape and refreshes FTS", async () => {
    const now = 5_000_000;
    await insertContent({
      id: "due2",
      status: "draft",
      publishAt: now - 1,
      data: { title: "Hook payload check" },
    });

    await runDueJobs(now);

    expect(hookState.calls).toHaveLength(1);
    expect(hookState.calls[0]).toEqual({
      type: "blog.post",
      id: "due2",
      data: { title: "Hook payload check" },
    });

    // FTS 行已重建(publish 後可被搜尋)。
    expect((await ftsCount("due2"))?.n).toBe(1);
  });

  it("leaves not-due drafts and already-published rows untouched", async () => {
    const now = 5_000_000;
    // 未到期草稿。
    await insertContent({
      id: "future",
      status: "draft",
      publishAt: now + 100_000,
      data: { title: "Future" },
    });
    // 未排程草稿。
    await insertContent({
      id: "unscheduled",
      status: "draft",
      publishAt: null,
      data: { title: "Unscheduled" },
    });
    // 已發佈但仍帶過去時戳(edge):status='draft' 過濾使其不被觸碰。
    await insertContent({
      id: "already",
      status: "published",
      publishAt: now - 1000,
      data: { title: "Already" },
    });

    const reports = await runDueJobs(now);
    expect(reports).toEqual([
      { id: "publish-due", ok: true, processed: 0 },
      EXT_JOBS_NOOP,
      LICENSE_CHECKIN_NOOP,
      STORAGE_PROBE_EMPTY,
    ]);
    expect(hookState.calls).toHaveLength(0);

    expect((await readRow("future"))?.status).toBe("draft");
    expect((await readRow("future"))?.publish_at).toBe(now + 100_000);
    expect((await readRow("unscheduled"))?.status).toBe("draft");
    expect((await readRow("already"))?.status).toBe("published");
    expect((await readRow("already"))?.publish_at).toBe(now - 1000);
  });

  it("is idempotent under a double run (second pass is a no-op)", async () => {
    const now = 5_000_000;
    await insertContent({
      id: "idem",
      status: "draft",
      publishAt: now - 1,
      data: { title: "Idem" },
    });

    const first = await runDueJobs(now);
    expect(first[0].processed).toBe(1);
    hookState.calls = [];

    const second = await runDueJobs(now + 10);
    expect(second[0].processed).toBe(0);
    expect(hookState.calls).toHaveLength(0);
  });

  it("writes lastRun bookkeeping (epoch ms) after running", async () => {
    const now = 7_777_000;
    await runDueJobs(now);
    expect(await getSetting<number>("core.jobs.lastRun.publish-due", 0)).toBe(
      now,
    );
  });

  it("isolates a job failure: reports ok:false, never throws, still bookkeeps", async () => {
    // 讓 publish-due 內部 select 失敗(丟掉 contents 表)以驗「throw → 被隔離捕捉」。
    await d1().exec("DROP TABLE contents;");
    const now = 8_888_000;

    const reports = await runDueJobs(now);
    expect(reports).toHaveLength(4);
    const publishDue = reports.find((r) => r.id === "publish-due")!;
    expect(publishDue.ok).toBe(false);
    expect(typeof publishDue.detail).toBe("string");
    // ext-jobs / license-checkin / storage-probe 不依賴 contents 表,失敗隔離下
    // 照常 no-op 成功。
    expect(reports.find((r) => r.id === "ext-jobs")).toEqual(EXT_JOBS_NOOP);
    expect(reports.find((r) => r.id === "license-checkin")).toEqual(
      LICENSE_CHECKIN_NOOP,
    );
    expect(reports.find((r) => r.id === "storage-probe")).toEqual(
      STORAGE_PROBE_EMPTY,
    );
    // 失敗仍寫 lastRun(記帳與任務結果解耦)。
    expect(await getSetting<number>("core.jobs.lastRun.publish-due", 0)).toBe(
      now,
    );

    // 還原,避免後續測試受影響。
    await d1().exec(CONTENTS_DDL);
  });
});

// ---- maybeRunJobs throttling ----

describe("maybeRunJobs — throttling", () => {
  it("no-ops within the sweep interval, then runs after it elapses", async () => {
    const base = 10_000_000;
    await insertContent({
      id: "sweep1",
      status: "draft",
      publishAt: base - 1,
      data: { title: "Sweep target" },
    });
    // 記錄一次剛發生的 sweep。
    await setSettings({ "core.jobs.lastSweep": base });

    // 60s 內再掃:節流 no-op,草稿仍為 draft。
    await maybeRunJobs(base + 1000);
    expect((await readRow("sweep1"))?.status).toBe("draft");

    // 超過間隔:實際執行,草稿發佈,lastSweep 前移。
    const later = base + 61_000;
    await maybeRunJobs(later);
    expect((await readRow("sweep1"))?.status).toBe("published");
    expect(await getSetting<number>("core.jobs.lastSweep", 0)).toBe(later);
  });

  it("runs when no prior sweep is recorded", async () => {
    const now = 12_000_000;
    await insertContent({
      id: "firstsweep",
      status: "draft",
      publishAt: now - 1,
      data: { title: "First" },
    });
    await maybeRunJobs(now);
    expect((await readRow("firstsweep"))?.status).toBe("published");
  });
});

// ---- CoreContentProvider publishAt write path ----

describe("CoreContentProvider — publishAt write path", () => {
  const provider = new CoreContentProvider(new HookBus());
  const def = {
    type: "blog.post",
    fields: [{ key: "title", type: "text" as const }],
  };

  async function ensure(): Promise<void> {
    await provider.ensureType(def);
  }

  it("persists publishAt as a row column, not inside JSON data", async () => {
    await ensure();
    const entry = await provider.create("blog.post", {
      title: "Sched",
      publishAt: 1_234_567,
    });
    const row = await readRow(entry.id);
    expect(row?.publish_at).toBe(1_234_567);
    // data JSON 不含 publishAt(row 欄位不落 JSON)。
    const data = JSON.parse(row?.data ?? "{}") as Record<string, unknown>;
    expect("publishAt" in data).toBe(false);
    expect(data.title).toBe("Sched");
    // 回傳 entry.data 亦不帶 publishAt。
    expect("publishAt" in entry.data).toBe(false);
  });

  it("defaults to NULL when publishAt is absent on create", async () => {
    await ensure();
    const entry = await provider.create("blog.post", { title: "NoSched" });
    expect((await readRow(entry.id))?.publish_at).toBeNull();
  });

  it("rejects invalid publishAt values with a validation error", async () => {
    await ensure();
    for (const bad of ["soon", -5, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        provider.create("blog.post", { title: "Bad", publishAt: bad }),
      ).rejects.toThrow();
    }
  });

  it("update sets, clears, and preserves publishAt per key presence", async () => {
    await ensure();
    const entry = await provider.create("blog.post", { title: "U" });
    expect((await readRow(entry.id))?.publish_at).toBeNull();

    // 帶 publishAt → 設定。
    await provider.update("blog.post", entry.id, { publishAt: 999 });
    expect((await readRow(entry.id))?.publish_at).toBe(999);

    // 未帶 publishAt key → 保留既有 column(改別的欄位)。
    await provider.update("blog.post", entry.id, { title: "U2" });
    expect((await readRow(entry.id))?.publish_at).toBe(999);

    // null → 明確清除。
    await provider.update("blog.post", entry.id, { publishAt: null });
    expect((await readRow(entry.id))?.publish_at).toBeNull();
  });
});

// ---- POST /api/jobs/run ----

describe("POST /api/jobs/run", () => {
  function runReq(origin = ORIGIN): Request {
    return new Request(`${ORIGIN}/api/jobs/run`, {
      method: "POST",
      headers: { Origin: origin },
    });
  }

  it("403 on cross-origin", async () => {
    const res = await POST(runReq("https://evil.test"));
    expect(res.status).toBe(403);
  });

  it("401 unauthenticated", async () => {
    authState.user = null;
    const res = await POST(runReq());
    expect(res.status).toBe(401);
  });

  it("403 for a non-admin (editor)", async () => {
    authState.user = EDITOR;
    const res = await POST(runReq());
    expect(res.status).toBe(403);
  });

  it("200 returns per-job results and processes due drafts", async () => {
    const now = Date.now();
    await insertContent({
      id: "apidue",
      status: "draft",
      publishAt: now - 1000,
      data: { title: "Via API" },
    });
    const res = await POST(runReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      ranAt: number;
      jobs: Array<{ id: string; ok: boolean; processed?: number }>;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.ranAt).toBe("number");
    expect(body.jobs).toEqual([
      { id: "publish-due", ok: true, processed: 1 },
      EXT_JOBS_NOOP,
      LICENSE_CHECKIN_NOOP,
      STORAGE_PROBE_EMPTY,
    ]);
    expect((await readRow("apidue"))?.status).toBe("published");
  });
});
