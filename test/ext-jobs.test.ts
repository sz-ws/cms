import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Extension, ExtJobRegistration } from "../src/ext/types";

// ext-jobs core job(docs/spec-extension-jobs.md)的 binding-backed 整合測試
// (miniflare D1)。同 jobs.test.ts:mock @/lib/cf 讓 db()/getDB() 直接打到
// cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// @/ext/loader 全 mock:rt.enabled 由每個測試自行指定(rtState),byId/hooks 依此
// 動態解析。workers pool 地雷:jobs.ts 本身只 dynamic import loader/services
// (見 src/lib/jobs.ts),此檔案的 mock 讓那些 dynamic import 落到這裡而非真實
// loader.ts(next/navigation 鏈)。
const rtState = vi.hoisted(() => ({ enabled: [] as Extension[] }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
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

import { runDueJobs } from "../src/lib/jobs";
import { invalidateSettingsCache } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const SETTINGS_DDL =
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);";
const EXT_JOBS_DDL =
  "CREATE TABLE IF NOT EXISTS ext_jobs (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, job_id TEXT NOT NULL, kind TEXT NOT NULL, run_at INTEGER NOT NULL, payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', last_run INTEGER, last_error TEXT, created_at INTEGER NOT NULL);";

beforeAll(async () => {
  await d1().exec(SETTINGS_DDL);
  await d1().exec(EXT_JOBS_DDL);
});

beforeEach(async () => {
  await d1().exec("DELETE FROM settings;");
  invalidateSettingsCache(); // 直接清表繞開寫入路徑,一併清 isolate settings 快取。
  await d1().exec("DELETE FROM ext_jobs;");
  rtState.enabled = [];
});

// ---- helpers ----

function fakeExt(id: string, jobs: ExtJobRegistration[]): Extension {
  return { id, name: id, version: "1.0.0", coreApi: "^1.10.0", jobs };
}

interface ExtJobRowFull {
  id: string;
  ext_id: string;
  job_id: string;
  kind: string;
  run_at: number;
  payload: string | null;
  attempts: number;
  status: string;
  last_run: number | null;
  last_error: string | null;
}

function getRecurringRow(
  extId: string,
  jobId: string,
): Promise<ExtJobRowFull | null> {
  return d1()
    .prepare(
      "SELECT * FROM ext_jobs WHERE ext_id = ? AND job_id = ? AND kind = 'recurring'",
    )
    .bind(extId, jobId)
    .first<ExtJobRowFull>();
}

async function countRecurringRows(
  extId: string,
  jobId: string,
): Promise<number> {
  const row = await d1()
    .prepare(
      "SELECT count(*) AS n FROM ext_jobs WHERE ext_id = ? AND job_id = ? AND kind = 'recurring'",
    )
    .bind(extId, jobId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function getOnceRow(id: string): Promise<ExtJobRowFull | null> {
  return d1()
    .prepare("SELECT * FROM ext_jobs WHERE id = ?")
    .bind(id)
    .first<ExtJobRowFull>();
}

interface Report {
  id: string;
  ok: boolean;
  processed?: number;
  detail?: string;
}

function findReport(reports: Report[], id: string): Report {
  const r = reports.find((x) => x.id === id);
  if (!r) throw new Error(`missing report for "${id}"`);
  return r;
}

/** 直接以 services.jobs(scoped to extId)排一次性任務,不經過 API layer。 */
async function scopedServicesFor(extId: string) {
  const { getExtRuntime } = await import("@/ext/loader");
  const { buildProviderRegistry, scopedServices } = await import(
    "../src/ext/services"
  );
  const rt = await getExtRuntime();
  const reg = buildProviderRegistry(rt);
  await reg.resolveActive();
  return scopedServices(extId, rt.hooks, reg);
}

const EVERY_MIN = 5;
const EVERY_MS = EVERY_MIN * 60_000;
const RETRY_BACKOFF_MS = 5 * 60_000;

// ---- 1. reconcile ----

describe("ext-jobs — reconcile", () => {
  it("inserts a row for a newly declared recurring job; first run is now+every, not immediate", async () => {
    const now = 1_000_000;
    rtState.enabled = [
      fakeExt("acme", [{ id: "sync", every: EVERY_MIN, run: vi.fn() }]),
    ];
    await runDueJobs(now);
    const row = await getRecurringRow("acme", "sync");
    expect(row).not.toBeNull();
    expect(row?.run_at).toBe(now + EVERY_MS);
    expect(row?.status).toBe("pending");
  });

  it("deletes the row once the extension no longer declares (or is disabled for) the job", async () => {
    const now = 1_000_000;
    rtState.enabled = [
      fakeExt("acme", [{ id: "sync", every: EVERY_MIN, run: vi.fn() }]),
    ];
    await runDueJobs(now);
    expect(await countRecurringRows("acme", "sync")).toBe(1);

    rtState.enabled = []; // extension disabled / job dropped
    await runDueJobs(now + 1000);
    expect(await countRecurringRows("acme", "sync")).toBe(0);
  });

  it("does not insert duplicates on repeated reconcile sweeps", async () => {
    const now = 1_000_000;
    rtState.enabled = [
      fakeExt("acme", [{ id: "sync", every: EVERY_MIN, run: vi.fn() }]),
    ];
    await runDueJobs(now);
    await runDueJobs(now + 1000);
    await runDueJobs(now + 2000);
    expect(await countRecurringRows("acme", "sync")).toBe(1);
  });
});

// ---- 2. recurring due execution + run_at advance + CAS ----

describe("ext-jobs — recurring execution", () => {
  it("executes a due recurring job and advances run_at by another `every`", async () => {
    const handler = vi.fn(async () => {});
    const now = 2_000_000;
    rtState.enabled = [
      fakeExt("acme", [{ id: "sync", every: EVERY_MIN, run: handler }]),
    ];
    await runDueJobs(now); // reconcile inserts, run_at = now + EVERY_MS (not due yet)
    expect(handler).not.toHaveBeenCalled();

    const due = now + EVERY_MS;
    const reports = await runDueJobs(due);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.anything(), null, due);

    const row = await getRecurringRow("acme", "sync");
    expect(row?.run_at).toBe(due + EVERY_MS);
    expect(row?.last_run).toBe(due);

    const report = findReport(reports, "ext-jobs");
    expect(report.processed).toBe(1);
  });

  it("only executes once under two concurrent sweeps hitting the same due row (CAS)", async () => {
    const handler = vi.fn(async () => {});
    const now = 3_000_000;
    rtState.enabled = [
      fakeExt("acme", [{ id: "sync", every: EVERY_MIN, run: handler }]),
    ];
    await runDueJobs(now); // seed the recurring row

    const due = now + EVERY_MS;
    const [r1, r2] = await Promise.all([runDueJobs(due), runDueJobs(due)]);
    expect(handler).toHaveBeenCalledTimes(1);

    const p1 = findReport(r1, "ext-jobs").processed ?? 0;
    const p2 = findReport(r2, "ext-jobs").processed ?? 0;
    expect(p1 + p2).toBe(1);

    // run_at 只推進了一次。
    const row = await getRecurringRow("acme", "sync");
    expect(row?.run_at).toBe(due + EVERY_MS);
  });
});

// ---- 3. recurring handler throw ----

describe("ext-jobs — recurring failure isolation", () => {
  it("records last_error on throw; other due jobs still run; next tick proceeds normally", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const ok = vi.fn(async () => {});
    const now = 4_000_000;
    rtState.enabled = [
      fakeExt("acme", [{ id: "bad", every: EVERY_MIN, run: failing }]),
      fakeExt("beta", [{ id: "good", every: EVERY_MIN, run: ok }]),
    ];
    await runDueJobs(now); // seed both

    const due = now + EVERY_MS;
    const reports = await runDueJobs(due);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);

    const badRow = await getRecurringRow("acme", "bad");
    expect(badRow?.last_error).toContain("boom");
    // run_at 仍照常推進(不重試不補跑)。
    expect(badRow?.run_at).toBe(due + EVERY_MS);

    const goodRow = await getRecurringRow("beta", "good");
    expect(goodRow?.last_error).toBeNull();

    const report = findReport(reports, "ext-jobs");
    expect(report.detail).toBe("1 failed");

    // 下一輪照常(不補跑上一輪失敗;若這次成功,last_error 清除)。
    failing.mockImplementation(async () => {});
    const nextDue = due + EVERY_MS;
    await runDueJobs(nextDue);
    expect(failing).toHaveBeenCalledTimes(2);
    const badRow2 = await getRecurringRow("acme", "bad");
    expect(badRow2?.last_error).toBeNull();
  });
});

// ---- 4 & 5. once: schedule → execute → delete; payload; retry/backoff/dead ----

describe("ext-jobs — once jobs", () => {
  it("schedule → executes at due time → row deleted; payload delivered as-is", async () => {
    let capturedPayload: unknown;
    const handler = vi.fn(async (_services, payload: unknown) => {
      capturedPayload = payload;
    });
    rtState.enabled = [fakeExt("acme", [{ id: "welcome", run: handler }])];

    const services = await scopedServicesFor("acme");
    const now = 5_000_000;
    const { id } = await services.jobs.schedule("welcome", now + 1000, {
      hello: "world",
    });
    expect(id).toBeTruthy();
    expect(await getOnceRow(id)).not.toBeNull();

    const reports = await runDueJobs(now + 1000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(capturedPayload).toEqual({ hello: "world" });
    expect(await getOnceRow(id)).toBeNull(); // deleted on success

    expect(findReport(reports, "ext-jobs").processed).toBe(1);
  });

  it("defaults payload to null when scheduled without one", async () => {
    let capturedPayload: unknown = "not-yet-set";
    const handler = vi.fn(async (_services, payload: unknown) => {
      capturedPayload = payload;
    });
    rtState.enabled = [fakeExt("acme", [{ id: "ping", run: handler }])];
    const services = await scopedServicesFor("acme");
    const now = 5_500_000;
    await services.jobs.schedule("ping", now);
    await runDueJobs(now);
    expect(capturedPayload).toBeNull();
  });

  it("backs off + tracks attempts on failure; dead after 3 attempts; dead rows are never picked up again", async () => {
    const handler = vi.fn(async () => {
      throw new Error("fail");
    });
    rtState.enabled = [fakeExt("acme", [{ id: "flaky", run: handler }])];
    const services = await scopedServicesFor("acme");
    const now = 6_000_000;
    const { id } = await services.jobs.schedule("flaky", now);

    await runDueJobs(now);
    let row = await getOnceRow(id);
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe("pending");
    expect(row?.run_at).toBe(now + RETRY_BACKOFF_MS);
    expect(row?.last_error).toContain("fail");

    await runDueJobs(now + RETRY_BACKOFF_MS);
    row = await getOnceRow(id);
    expect(row?.attempts).toBe(2);
    expect(row?.status).toBe("pending");

    await runDueJobs(now + 2 * RETRY_BACKOFF_MS);
    row = await getOnceRow(id);
    expect(row?.attempts).toBe(3);
    expect(row?.status).toBe("dead");

    // dead:不再被撿起,即便到期。
    handler.mockClear();
    await runDueJobs(now + 3 * RETRY_BACKOFF_MS);
    expect(handler).not.toHaveBeenCalled();
    row = await getOnceRow(id);
    expect(row?.status).toBe("dead");
    expect(row?.attempts).toBe(3);
  });

  it("marks dead immediately when the scheduled handler no longer exists at run time", async () => {
    rtState.enabled = [
      fakeExt("acme", [{ id: "temp", run: vi.fn() }]),
    ];
    const services = await scopedServicesFor("acme");
    const now = 6_500_000;
    const { id } = await services.jobs.schedule("temp", now);

    // extension redeployed without that handler declared anymore.
    rtState.enabled = [fakeExt("acme", [{ id: "other", run: vi.fn() }])];
    await runDueJobs(now);

    const row = await getOnceRow(id);
    expect(row?.status).toBe("dead");
    expect(row?.last_error).toBe("handler not found");
  });
});

// ---- 6. cancel ----

describe("ext-jobs — cancel", () => {
  it("the owning extension can cancel a pending once job", async () => {
    rtState.enabled = [fakeExt("acme", [{ id: "task", run: vi.fn() }])];
    const services = await scopedServicesFor("acme");
    const { id } = await services.jobs.schedule("task", Date.now() + 100_000);
    await services.jobs.cancel(id);
    expect(await getOnceRow(id)).toBeNull();
  });

  it("an out-of-scope extId is a silent no-op (does not reveal existence)", async () => {
    rtState.enabled = [fakeExt("acme", [{ id: "task", run: vi.fn() }])];
    const services = await scopedServicesFor("acme");
    const { id } = await services.jobs.schedule("task", Date.now() + 100_000);

    const mallory = await scopedServicesFor("mallory");
    await expect(mallory.jobs.cancel(id)).resolves.toBeUndefined();
    expect(await getOnceRow(id)).not.toBeNull(); // untouched
  });

  it("cancel also removes a dead row (observability cleanup)", async () => {
    const handler = vi.fn(async () => {
      throw new Error("dies");
    });
    rtState.enabled = [fakeExt("acme", [{ id: "flaky", run: handler }])];
    const services = await scopedServicesFor("acme");
    const now = 7_000_000;
    const { id } = await services.jobs.schedule("flaky", now);
    await runDueJobs(now);
    await runDueJobs(now + RETRY_BACKOFF_MS);
    await runDueJobs(now + 2 * RETRY_BACKOFF_MS);
    expect((await getOnceRow(id))?.status).toBe("dead");

    await services.jobs.cancel(id);
    expect(await getOnceRow(id)).toBeNull();
  });
});

// ---- 7. scoped schedule validation ----

describe("ext-jobs — services.jobs.schedule validation", () => {
  it("throws when jobId is not declared by the calling extension", async () => {
    rtState.enabled = [fakeExt("acme", [{ id: "known", run: vi.fn() }])];
    const services = await scopedServicesFor("acme");
    await expect(
      services.jobs.schedule("unknown-job", Date.now() + 1000),
    ).rejects.toThrow();
  });

  it("throws when runAt is not a finite positive integer", async () => {
    rtState.enabled = [fakeExt("acme", [{ id: "known", run: vi.fn() }])];
    const services = await scopedServicesFor("acme");
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(services.jobs.schedule("known", bad)).rejects.toThrow();
    }
  });

  it("a periodic job's own id (has `every`) is still a valid schedule target (it's also a handler)", async () => {
    rtState.enabled = [
      fakeExt("acme", [{ id: "sync", every: EVERY_MIN, run: vi.fn() }]),
    ];
    const services = await scopedServicesFor("acme");
    const { id } = await services.jobs.schedule("sync", Date.now() + 1000);
    expect(await getOnceRow(id)).not.toBeNull();
  });
});
