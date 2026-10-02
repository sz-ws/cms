import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { COMBINED_STAMP_SQL } from "../src/lib/stamps";

// 合併戳的查詢每個請求都跑(後台、/api、排程),D1 依「掃過的列」計費。
// 這裡釘住它的成本:每張表只掃一次。

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const SETTINGS = 40;
const EXTENSIONS = 10;
const DECLARATIVE = 3;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
  );
  await d1().exec("DELETE FROM settings;");
  await d1().exec("DELETE FROM extensions;");
  await d1().exec("DELETE FROM declarative_extensions;");
  const rows: D1PreparedStatement[] = [];
  for (let i = 0; i < SETTINGS; i += 1) {
    rows.push(d1().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)").bind(`k${i}`, 1000 + i));
  }
  for (let i = 0; i < EXTENSIONS; i += 1) {
    rows.push(
      d1()
        .prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES (?, ?, '1.0.0', 1, ?)")
        .bind(`e${i}`, i % 2, 2000 + i),
    );
  }
  for (let i = 0; i < DECLARATIVE; i += 1) {
    rows.push(
      d1()
        .prepare("INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at) VALUES (?, '{}', '1.0.0', 1, NULL, 1, ?)")
        .bind(`d${i}`, 3000 + i),
    );
  }
  await d1().batch(rows);
});

describe("COMBINED_STAMP_SQL", () => {
  it("returns the eight numbers the three stamps are made of", async () => {
    const row = await d1().prepare(COMBINED_STAMP_SQL).first();
    expect(row).toEqual({
      sN: SETTINGS,
      sM: 1000 + SETTINGS - 1,
      exN: EXTENSIONS,
      exM: 2000 + EXTENSIONS - 1,
      exE: EXTENSIONS / 2,
      dxN: DECLARATIVE,
      dxM: 3000 + DECLARATIVE - 1,
      dxE: DECLARATIVE,
    });
  });

  it("reads each table once", async () => {
    const result = await d1().prepare(COMBINED_STAMP_SQL).all();
    // 每張表一趟,外加把三個子查詢的結果(各一列)接起來時讀的那幾列。
    // 一個數字一條 subselect 的寫法是 2 × settings + 3 × extensions + 3 × declarative。
    const oneScanEach = SETTINGS + EXTENSIONS + DECLARATIVE;
    expect(result.meta.rows_read).toBeGreaterThanOrEqual(oneScanEach);
    expect(result.meta.rows_read).toBeLessThanOrEqual(oneScanEach + 3);
  });
});
