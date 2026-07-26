import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ConfigShapeError,
  placeholderD1,
  readWranglerConfig,
  writeD1Ids,
} from "./wrangler-config.js";
import { PLACEHOLDER_ID } from "./wrangler.js";

// 刻意複製正式 wrangler.jsonc 的形狀:註解壓在欄位上、兩組 D1(只有第一組有
// migrations_dir)、兩組 R2、還有絕對不能被動到的 main / triggers。
const FIXTURE = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  // main 指向 custom-worker.ts,而不是 OpenNext 直接產出的 .open-next/worker.js。
  "main": "custom-worker.ts",
  "name": "cms",
  // 分鐘級準時排程。
  "triggers": { "crons": ["* * * * *"] },
  "compatibility_date": "2024-12-30",
  "d1_databases": [
    // database_id 為佔位值,部署前必須換成真的 UUID。
    { "binding": "DB", "database_name": "cms-db", "database_id": "${PLACEHOLDER_ID}", "migrations_dir": "migrations" },
    // 這是**第二個**佔位值 —— 很容易漏掉。
    { "binding": "NEXT_TAG_CACHE_D1", "database_name": "cms-tag-cache", "database_id": "${PLACEHOLDER_ID}" }
  ],
  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "cms-storage" },
    { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "cms-next-cache" }
  ]
}
`;

const REAL_A = "11111111-2222-3333-4444-555555555555";
const REAL_B = "66666666-7777-8888-9999-aaaaaaaaaaaa";

describe("readWranglerConfig", () => {
  it("讀出兩組 D1 與兩組 R2,並標出誰有 migrations_dir", () => {
    const c = readWranglerConfig(FIXTURE);
    expect(c.workerName).toBe("cms");
    expect(c.d1.map((d) => d.databaseName)).toEqual(["cms-db", "cms-tag-cache"]);
    expect(c.d1.map((d) => d.binding)).toEqual(["DB", "NEXT_TAG_CACHE_D1"]);
    // 只有 cms-db 該跑 migrations;tag cache 的表由 OpenNext 部署時自建。
    expect(c.d1.map((d) => d.hasMigrationsDir)).toEqual([true, false]);
    expect(c.r2.map((b) => b.bucketName)).toEqual(["cms-storage", "cms-next-cache"]);
  });

  it("兩個佔位值都被抓出來(DEPLOY.md 說最容易漏掉第二個)", () => {
    expect(placeholderD1(readWranglerConfig(FIXTURE)).map((d) => d.databaseName)).toEqual([
      "cms-db",
      "cms-tag-cache",
    ]);
  });

  it("形狀不對時給得出人看得懂的錯誤", () => {
    expect(() => readWranglerConfig(`{ "d1_databases": {} }`)).toThrow(ConfigShapeError);
    expect(() => readWranglerConfig(`{ "d1_databases": [{ "binding": "DB" }] }`)).toThrow(
      /missing database_name/,
    );
    expect(() => readWranglerConfig(`[]`)).toThrow(/root is not an object/);
  });
});

describe("writeD1Ids", () => {
  it("寫回兩個 id,註解與排版一個字都沒少", () => {
    const { text, changed } = writeD1Ids(
      FIXTURE,
      new Map([
        ["cms-db", REAL_A],
        ["cms-tag-cache", REAL_B],
      ]),
    );
    expect(changed).toEqual(["cms-db", "cms-tag-cache"]);
    expect(text).toContain(`"database_id": "${REAL_A}"`);
    expect(text).toContain(`"database_id": "${REAL_B}"`);
    expect(text).not.toContain(PLACEHOLDER_ID);

    // 註解全數存活。
    expect(text).toContain("// main 指向 custom-worker.ts");
    expect(text).toContain("// 分鐘級準時排程。");
    expect(text).toContain("// database_id 為佔位值");
    expect(text).toContain("// 這是**第二個**佔位值");

    // 別人維護的欄位一個 byte 都沒動。
    expect(text).toContain(`"main": "custom-worker.ts"`);
    expect(text).toContain(`"triggers": { "crons": ["* * * * *"] }`);
    expect(text).toContain(`"$schema": "node_modules/wrangler/config-schema.json"`);

    // 差異只出現在那兩個 id 上 —— 逐行比對,其他行必須完全相同。
    const before = FIXTURE.split("\n");
    const after = text.split("\n");
    expect(after.length).toBe(before.length);
    const diffIndexes = before
      .map((line, i) => (line === after[i] ? -1 : i))
      .filter((i) => i >= 0);
    expect(diffIndexes.length).toBe(2);
  });

  it("冪等:值已經正確時完全不產生編輯", () => {
    const once = writeD1Ids(FIXTURE, new Map([["cms-db", REAL_A]]));
    const twice = writeD1Ids(once.text, new Map([["cms-db", REAL_A]]));
    expect(twice.changed).toEqual([]);
    expect(twice.text).toBe(once.text);
  });

  it("只更新有指派到的那一個,另一個佔位值原封不動", () => {
    const { text, changed } = writeD1Ids(FIXTURE, new Map([["cms-tag-cache", REAL_B]]));
    expect(changed).toEqual(["cms-tag-cache"]);
    expect(text).toContain(`"database_name": "cms-db", "database_id": "${PLACEHOLDER_ID}"`);
    expect(text).toContain(`"database_id": "${REAL_B}"`);
  });

  it("不認識的 database_name 直接忽略,不會亂寫", () => {
    const { text, changed } = writeD1Ids(FIXTURE, new Map([["not-ours", REAL_A]]));
    expect(changed).toEqual([]);
    expect(text).toBe(FIXTURE);
  });

  it("database_id 鍵不存在時補一個,結果仍是合法 JSONC", () => {
    const trimmed = `{
  "d1_databases": [
    // 有人手工砍掉了 database_id
    { "binding": "DB", "database_name": "cms-db", "migrations_dir": "migrations" }
  ]
}
`;
    const { text, changed } = writeD1Ids(trimmed, new Map([["cms-db", REAL_A]]));
    expect(changed).toEqual(["cms-db"]);
    expect(text).toContain("// 有人手工砍掉了 database_id");
    const reparsed = readWranglerConfig(text);
    expect(reparsed.d1[0].currentId).toBe(REAL_A);
    expect(reparsed.d1[0].hasMigrationsDir).toBe(true);
  });

  it("寫回去的內容能被自己重新解析(往返穩定)", () => {
    const { text } = writeD1Ids(
      FIXTURE,
      new Map([
        ["cms-db", REAL_A],
        ["cms-tag-cache", REAL_B],
      ]),
    );
    const c = readWranglerConfig(text);
    expect(c.d1.map((d) => d.currentId)).toEqual([REAL_A, REAL_B]);
    expect(placeholderD1(c)).toEqual([]);
  });
});

describe("真實的 wrangler.jsonc", () => {
  // 對著 repo 裡那份真檔跑。刻意只斷言結構性事實(解析得動、binding 在、
  // 只有一個 D1 宣告 migrations_dir),這樣註解或欄位增修不會誤殺這個測試,
  // 但「設定檔變成 CLI 解析不了的形狀」一定會被抓到。
  it("解析得動,且 binding 與 migrations_dir 的分佈符合預期", async () => {
    const real = await readFile(
      path.join(process.cwd(), "wrangler.jsonc"),
      "utf8",
    );
    const c = readWranglerConfig(real);
    expect(c.workerName).toBe("cms");
    expect(c.d1.map((d) => d.binding)).toContain("DB");
    expect(c.d1.map((d) => d.binding)).toContain("NEXT_TAG_CACHE_D1");
    expect(c.r2.map((b) => b.binding)).toContain("STORAGE");
    expect(c.r2.map((b) => b.binding)).toContain("NEXT_INC_CACHE_R2_BUCKET");
    expect(c.d1.filter((d) => d.hasMigrationsDir).map((d) => d.databaseName)).toEqual([
      "cms-db",
    ]);
  });
});
