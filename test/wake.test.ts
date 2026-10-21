import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Extension, ExtJobRegistration } from "../src/ext/types";

// core 1.80.0 排程「有事才醒」(src/lib/wake.ts):記號的寫入與清除、ledger-kit 交易順便設記號、被叫醒的那一輪
// 週期性工作照跑。miniflare D1;loader 照 ext-jobs.test.ts 的作法 mock。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

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

import { clearWake, requestWake, setWakeTables, shouldTick, wokenAt, WAKE_KEY, SAFETY_INTERVAL_MS } from "../src/lib/wake";
import { commitLedgerOperations, prepareTransaction, transactionSchema } from "../src/ext/ledger-kit";
import { runDueJobs } from "../src/lib/jobs";
import { invalidateSettingsCache } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;
const PREFIX = "ext_wakeprobe";

beforeAll(async () => {
  for (const statement of [
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS heartbeats (key TEXT PRIMARY KEY, at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS ext_jobs (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, job_id TEXT NOT NULL, kind TEXT NOT NULL, run_at INTEGER NOT NULL, payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', last_run INTEGER, last_error TEXT, created_at INTEGER NOT NULL)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ext_jobs_recurring ON ext_jobs (ext_id, job_id) WHERE kind = 'recurring'",
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT, status TEXT, data TEXT, locale TEXT, publish_at INTEGER, created_at INTEGER, updated_at INTEGER)",
    `CREATE TABLE IF NOT EXISTS ${PREFIX}_outbox (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${PREFIX}_notes (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
    ...transactionSchema(PREFIX).split(";").map((s) => s.trim()).filter(Boolean),
  ]) await d1().prepare(statement).run();
});

beforeEach(async () => {
  for (const table of ["settings", "heartbeats", "ext_jobs", `${PREFIX}_outbox`, `${PREFIX}_notes`, `${PREFIX}_operations`]) await d1().prepare(`DELETE FROM ${table}`).run();
  invalidateSettingsCache();
  setWakeTables([]);
  rtState.enabled = [];
});

const wakeAt = async () => (await d1().prepare("SELECT at FROM heartbeats WHERE key = ?").bind(WAKE_KEY).first<{ at: number }>())?.at ?? null;
const insert = (table: string) => commitLedgerOperations({ id: crypto.randomUUID(), actor: { type: "system", id: "test" }, reason: "test" }, [prepareTransaction(d1(), PREFIX, [{ kind: "insert", table, values: { id: crypto.randomUUID(), created_at: 1 } }])]);

describe("shouldTick", () => {
  const now = 1_800_000_000_000;
  const quiet = { wake_at: null, last_tick: now - 60_000, next_job: now + 10 * 60_000, next_publish: null };
  it("stays asleep when nothing is due and the last full tick is recent", () => {
    expect(shouldTick(quiet, now)).toBe(false);
  });
  it("wakes for a due mark, a due job, due content, a stale or missing last tick", () => {
    expect(shouldTick({ ...quiet, wake_at: now }, now)).toBe(true);
    expect(shouldTick({ ...quiet, next_job: now + 10_000 }, now)).toBe(true); // within the tolerance
    expect(shouldTick({ ...quiet, next_publish: now - 1 }, now)).toBe(true);
    expect(shouldTick({ ...quiet, last_tick: now - SAFETY_INTERVAL_MS }, now)).toBe(true);
    expect(shouldTick({ ...quiet, last_tick: null }, now)).toBe(true);
  });
  it("a mark set for later does not wake it yet", () => {
    expect(shouldTick({ ...quiet, wake_at: now + 60_000 }, now)).toBe(false);
  });
});

describe("the wake mark", () => {
  it("keeps the earliest time; clearing after a tick keeps a mark set later", async () => {
    await requestWake(d1(), 5_000);
    await requestWake(d1(), 9_000);
    expect(await wakeAt()).toBe(5_000);
    expect(await wokenAt(d1(), 4_999)).toBe(false);
    expect(await wokenAt(d1(), 5_000)).toBe(true);
    await clearWake(d1(), 4_000); // the tick started before the mark: keep it
    expect(await wakeAt()).toBe(5_000);
    await clearWake(d1(), 5_000);
    expect(await wakeAt()).toBeNull();
  });
});

describe("ledger-kit transactions set the mark for the tables plugins named", () => {
  it("an insert into a named table sets it; another table does not", async () => {
    setWakeTables([`${PREFIX}_outbox`]);
    await insert(`${PREFIX}_notes`);
    expect(await wakeAt()).toBeNull();
    const before = Date.now();
    await insert(`${PREFIX}_outbox`);
    expect(await wakeAt()).toBeGreaterThanOrEqual(before);
  });

  it("nothing is named: no mark, and no heartbeats statement at all", async () => {
    await insert(`${PREFIX}_outbox`);
    expect(await wakeAt()).toBeNull();
  });
});

describe("a woken tick runs every recurring job, then clears the mark", () => {
  function extWith(runs: string[]): Extension {
    const job: ExtJobRegistration = { id: "sweep", every: 30, wakeOn: [`${PREFIX}_outbox`], run: async () => { runs.push("sweep"); } };
    return { id: "probe", name: "probe", version: "1.0.0", coreApi: "^1.80.0", jobs: [job] };
  }

  it("not woken: a job due in 30 minutes waits; woken: it runs now and the mark is gone", async () => {
    const runs: string[] = [];
    rtState.enabled = [extWith(runs)];
    const now = Date.now();
    await runDueJobs(now); // creates the recurring row, due in 30 minutes
    await runDueJobs(now + 60_000);
    expect(runs).toEqual([]);

    await requestWake(d1(), now + 60_000);
    await runDueJobs(now + 120_000);
    expect(runs).toEqual(["sweep"]);
    expect(await wakeAt()).toBeNull();

    await runDueJobs(now + 180_000); // no new mark: asleep again
    expect(runs).toEqual(["sweep"]);
  });
});
