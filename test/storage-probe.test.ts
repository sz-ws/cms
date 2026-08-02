import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

vi.mock("@/lib/cf", () => ({
  getDB: () => (env as { DB: D1Database }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const { runDueJobs } = await import("@/lib/jobs");

const d1 = () => (env as { DB: D1Database }).DB;

// 與 migrations/0015_storage_history.sql 同形。這裡刻意抄一份而不是 ?raw 匯入:
// 這張表只有四個純量欄、無 trigger、無 DDL 巧妙之處,抄一份的漂移風險遠低於
// 為它引進一套 SQL 切分重現邏輯。
const HISTORY_DDL =
  "CREATE TABLE IF NOT EXISTS storage_history (at INTEGER PRIMARY KEY, size_after INTEGER NOT NULL, rows_read INTEGER, note TEXT);";

// runDueJobs 會跑全部四支 core job;其餘三支需要這些表存在才不會汙染結果。
const OTHER_DDL = [
  "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT, translation_group TEXT, slug TEXT, status TEXT NOT NULL, data TEXT NOT NULL, publish_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS ext_jobs (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, job_id TEXT NOT NULL, kind TEXT NOT NULL, run_at INTEGER NOT NULL, payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', last_run INTEGER, last_error TEXT, created_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
];

const probeReport = (reports: { id: string }[]) =>
  reports.find((r) => r.id === "storage-probe") as {
    id: string;
    ok: boolean;
    processed?: number;
    detail?: string;
  };

// ⚠️ miniflare 的 D1 是**跨測試檔共用**的,而 test/jobs.test.ts 也會跑 runDueJobs
// (那會寫進同一張 storage_history)。beforeEach 的 DELETE 擋不住併行的其他檔案,
// 所以這裡用一個遠離其他檔案的時間基準,並把查詢限縮在自己的區間內。
const T0 = 5_000_000_000;

const history = async () =>
  (
    await d1()
      .prepare(
        "SELECT at, size_after, rows_read FROM storage_history WHERE at >= ? ORDER BY at",
      )
      .bind(T0)
      .all<{ at: number; size_after: number; rows_read: number | null }>()
  ).results;

describe("storage-probe — D1 用量預警", () => {
  beforeAll(async () => {
    await d1().exec(HISTORY_DDL);
    for (const ddl of OTHER_DDL) await d1().exec(ddl);
  });

  beforeEach(async () => {
    await d1().exec(`DELETE FROM storage_history WHERE at >= ${T0};`);
    await d1().exec("DELETE FROM settings;");
  });

  it("D1 的 meta 真的回 size_after —— 整支 job 的前提", async () => {
    const r = await d1().prepare("SELECT 1").all();
    // 這條斷言存在的意義:哪天 workerd 拿掉或改名這個欄位,這裡會先紅,
    // 而不是讓 job 靜默降級成「size_after 不可用」永遠不再預警。
    expect(typeof r.meta?.size_after).toBe("number");
    expect(r.meta!.size_after).toBeGreaterThan(0);
  });

  it("第一次探測寫下一列快照,detail 報當下大小", async () => {
    const reports = await runDueJobs(T0);
    const probe = probeReport(reports);

    expect(probe.ok).toBe(true);
    expect(probe.processed).toBe(1);
    // 第一次沒有基準,不該出現「自上次」的增減字樣。
    expect(probe.detail).not.toContain("自上次");

    const rows = await history();
    expect(rows).toHaveLength(1);
    expect(rows[0].at).toBe(T0);
    expect(rows[0].size_after).toBeGreaterThan(0);
  });

  it("6 小時內重跑不寫第二列(否則每分鐘的 sweep 會塞爆歷史)", async () => {
    await runDueJobs(T0);
    const probe = probeReport(await runDueJobs(T0 + 60_000));

    expect(probe.detail).toBe("not_due");
    expect(probe.processed).toBe(0);
    expect(await history()).toHaveLength(1);
  });

  it("超過 6 小時才寫下一列,並報出與上次的差", async () => {
    await runDueJobs(T0);
    const sixHours = 6 * 60 * 60 * 1000;
    const probe = probeReport(await runDueJobs(T0 + sixHours + 1));

    expect(probe.processed).toBe(1);
    // 有基準了就必須帶趨勢 —— 「還剩多少」不知道急不急,「多久漲多少」才知道。
    expect(probe.detail).toContain("自上次");

    expect(await history()).toHaveLength(2);
  });

  it("這支 job 幾乎不讀列 —— 它不該退化成統計查詢", async () => {
    await runDueJobs(T0);
    const [row] = await history();
    // SELECT 1 不掃任何使用者資料。若有人「順手」在這裡加 count(*),
    // rows_read 會爆掉,這條就會紅。D1 按 rows read 計費(Free 每天 500 萬列)。
    expect(row.rows_read ?? 0).toBeLessThan(10);
  });

  it("表不存在時回報 ok:false,不靜默吞掉", async () => {
    // 「用量預警沒在跑」本身就該被看見 —— 刻意不 catch 成 ok:true。
    // (失敗隔離「其他 job 不受影響」由 test/jobs.test.ts 以完整 DDL 涵蓋,
    //  這個檔案的精簡 DDL 撐不起那個斷言,不在這裡重複。)
    await d1().exec("DROP TABLE storage_history;");

    expect(probeReport(await runDueJobs(T0 + 999)).ok).toBe(false);

    await d1().exec(HISTORY_DDL);
  });
});
