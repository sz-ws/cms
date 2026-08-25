// Migration 不變量:migrations/ 從零套用到真 D1(workerd)後,結果必須與
// src/lib/schema.ts 逐表、逐欄、逐索引、逐 FK 一致。
//
// 這支測試存在的理由(也是它守住的三條約定,見 0005/0010/0014 各檔頭):
//   1. `pnpm db:generate` 已停用,0005 起全是手寫 SQL —— 沒有工具保證 schema.ts
//      和 migrations/ 說的是同一個資料庫。0007 的兩個索引就曾只活在 raw SQL 裡
//      (0010 檔頭點名的漂移),0015 的 storage_history_at_desc 也一度如此。
//      這裡把「同名同欄」從檔頭裡的君子協定變成紅燈。
//   2. fresh install 路徑(全新 D1 + 依檔名順序套用全部 migration)是每個新客戶
//      站的第一步,必須永遠可行 —— 包含 FTS5 虛擬表真的建得起來這件事,只有
//      跑在 workerd 的 D1 上才算證明(node 端 mock 不算)。
//   3. drizzle journal(meta/_journal.json)凍結在 idx 4:誰哪天手滑跑了
//      drizzle-kit generate 並 commit,journal 會長出撞號的新 entry,這裡先紅。
//   4. migrations/ 是 append-only:舊檔在每個既有部署的 D1 上都已經套用過,事後
//      改它不會回頭改任何資料庫 —— 只會讓「從零套用」與「既有站」分岔成兩個
//      schema,而且兩邊都不報錯。上面第 1 點天生看不到這種分岔(改過的舊檔配
//      改過的 schema.ts,從零套用照樣自洽),所以另外記一本雜湊帳:
//      migrations/meta/_checksums.json,由 `pnpm db:checksums` 維護。
//
// 專用 MIGRATIONS_DB binding(vitest.config.ts):共用的 DB 上各測試檔已用
// CREATE TABLE IF NOT EXISTS 鋪了自己的最小鏡像,從零套用會撞名。
//
// 已知且刻意的 schema.ts 缺席(raw-SQL-only 構造)集中宣告在 RAW_SQL_ONLY_TABLES:
// 目前只有 content_fts(FTS5,drizzle 無法建模,見 0005/0011 檔頭)。新增這類
// 構造時必須同步加進該清單 —— 清單就是「哪些東西 schema.ts 描述不了」的帳本。
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { is, getTableName } from "drizzle-orm";
import { getTableConfig, SQLiteTable, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { SQLiteColumn, Index } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/schema";
import journal from "../migrations/meta/_journal.json";
import checksums from "../migrations/meta/_checksums.json";

const db = () => (env as unknown as { MIGRATIONS_DB: D1Database }).MIGRATIONS_DB;

// ── migration 檔案(build 時由 vite 以 ?raw 內嵌,workerd 內無檔案系統)──────
const rawByPath = import.meta.glob("../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const files = Object.entries(rawByPath)
  .map(([path, sql]) => ({ name: path.replace(/^.*\//, ""), sql }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

// raw-SQL-only 表(schema.ts 刻意缺席)。content_fts 的 FTS5 影子表
// (content_fts_data/_idx/_content/_docsize/_config)一併豁免。
const RAW_SQL_ONLY_TABLES = new Set(["content_fts"]);
const isExemptTable = (name: string) =>
  RAW_SQL_ONLY_TABLES.has(name) ||
  name.startsWith("content_fts_") ||
  name.startsWith("sqlite_") ||
  name.startsWith("_cf_") ||
  name === "d1_migrations";

// ── SQL 切分:去掉 `--` 行註解後以 `;` 分句 ─────────────────────────────────
// 與 wrangler 的行為對齊到「本 repo 的 migration 用得到」的程度:無 trigger
// (BEGIN…END 內含分號)、字串常值內無 `--` 或 `;`。奇數個單引號的分句會被擋下
// —— 真要寫這類 SQL 時,先擴充這個切分器。
function splitStatements(sql: string): string[] {
  const stripped = sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
  const stmts = stripped
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) {
    const quotes = (s.match(/'/g) ?? []).length;
    if (quotes % 2 !== 0)
      throw new Error(
        `splitStatements:分句內單引號不成對(字串常值含 ; 或 -- ?),需擴充切分器:\n${s}`,
      );
  }
  return stmts;
}

// ── schema.ts 的期望形狀 ────────────────────────────────────────────────────
const drizzleTables = Object.values(schema).filter((v): v is SQLiteTable =>
  is(v, SQLiteTable),
);

type IndexCfg = Index["config"];
const indexConfigs = (t: SQLiteTable): IndexCfg[] =>
  getTableConfig(t).indexes.map((i) => (i as Index).config);

const sqlLiteral = (v: unknown): string =>
  typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v);

// partial index 的 WHERE 述詞:drizzle 渲染成 `"ext_jobs"."kind" = 'recurring'`,
// 手寫 migration 寫的是 `kind = 'recurring'` —— 同一個述詞的兩種寫法,正規化(去
// 識別字引號、去表名限定、壓掉可有可無的空白)後才比得了。
// 為什麼非比不可:述詞就是 ext_jobs_recurring 那條完整性不變量的**全部內容**
// (「每個 (ext, job) 至多一列 recurring」),只比「有沒有 WHERE」等於沒比 ——
// 把述詞改成 kind = 'once' 會靜靜地換掉一條不變量而測試全綠。
const dialect = new SQLiteSyncDialect();
const normalizePredicate = (predicate: string, table: string): string =>
  predicate
    .replace(/["`]/g, "")
    .replaceAll(`${table}.`, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([=<>!(),])\s*/g, "$1")
    .trim();

// 換行先正規化成 LF:repo 沒有 .gitattributes,Windows 上 core.autocrlf 的
// checkout 會拿到 CRLF —— 那不該讓帳本永遠紅。與 scripts/db-checksums.mjs 同法。
const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text.replace(/\r\n/g, "\n")),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

describe("migration parity — migrations/ 與 schema.ts 說的是同一個資料庫", () => {
  beforeAll(async () => {
    // watch-mode 重跑 / storage 殘留防禦:清掉上一輪的表再從零套用。
    // FK 依賴讓 DROP 順序有講究 —— 固定點迴圈,失敗的下一輪再試。
    for (let pass = 0; pass < 6; pass++) {
      const rows = (
        await db()
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
          )
          .all<{ name: string }>()
      ).results;
      if (rows.length === 0) break;
      for (const { name } of rows) {
        try {
          await db().prepare(`DROP TABLE "${name}"`).run();
        } catch {
          // FTS5 影子表 / FK 父表:等宿主表或子表先掉,下一輪自然消失。
        }
      }
    }

    for (const f of files) {
      for (const stmt of splitStatements(f.sql)) {
        try {
          await db().prepare(stmt).run();
        } catch (e) {
          throw new Error(`套用 ${f.name} 失敗於:\n${stmt}\n→ ${String(e)}`);
        }
      }
    }
  });

  // ── 檔名與 journal 紀律 ───────────────────────────────────────────────────
  it("檔名符合 NNNN_slug.sql 且編號不重複(wrangler 依檔名排序,撞號 = 順序未定義)", () => {
    expect(files.length).toBeGreaterThan(0);
    const nums: number[] = [];
    for (const f of files) {
      const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f.name);
      expect(m, `${f.name} 不符合 NNNN_slug.sql(小寫 a-z0-9_)`).toBeTruthy();
      nums.push(Number(m![1]));
    }
    // 缺號合法(0012/0013 已是歷史事實);重號不合法。
    expect(new Set(nums).size, `編號重複:${nums.join(",")}`).toBe(nums.length);
  });

  it("drizzle journal 凍結在 idx 4 —— 長出新 entry 表示有人跑了 db:generate", () => {
    expect(
      journal.entries.length,
      "meta/_journal.json 多出 0004 之後的 entry。db:generate 已停用:revert journal/snapshot,改用 pnpm db:new 手寫 SQL。",
    ).toBe(5);
    const names = new Set(files.map((f) => f.name));
    for (const e of journal.entries) {
      expect(e.idx).toBeLessThanOrEqual(4);
      expect(names.has(`${e.tag}.sql`), `journal tag ${e.tag} 沒有對應檔案`).toBe(true);
    }
  });

  it("既有 migration 未被改動(append-only 帳本 migrations/meta/_checksums.json)", async () => {
    const ledger = checksums.files as Record<string, string>;
    const actual: Record<string, string> = {};
    for (const f of files) actual[f.name] = await sha256(f.sql);

    expect(
      Object.keys(actual).sort(),
      "帳本與 migrations/ 的檔案清單對不上:多出來的是新檔沒登錄(跑 pnpm db:checksums);少的是已出貨的 migration 被刪了(不該刪)。",
    ).toEqual(Object.keys(ledger).sort());

    for (const name of Object.keys(actual)) {
      expect(
        actual[name],
        `${name} 的內容與帳本不符 —— 已出貨的 migration 是 append-only:它在既有部署的 D1 上早就套用過,改檔案不會回頭改資料庫,只會讓新站與舊站分岔成兩個 schema。要改 schema 請開下一個 migration(pnpm db:new);真的是刻意重寫這個檔,才跑 pnpm db:checksums 重新登錄。`,
      ).toBe(ledger[name]);
    }
  });

  // ── 表集合 ────────────────────────────────────────────────────────────────
  it("表集合一致:migration 建的每張表都在 schema.ts,反之亦然", async () => {
    const actual = (
      await db()
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all<{ name: string }>()
    ).results
      .map((r) => r.name)
      .filter((n) => !isExemptTable(n))
      .sort();
    const expected = drizzleTables.map((t) => getTableConfig(t).name).sort();
    // 讀 diff 的方法:actual 少了誰 = migration 忘了建 / schema.ts 忘了刪;
    // actual 多了誰 = 手寫 migration 建了表卻沒進 schema.ts(0007 式漂移)。
    expect(actual).toEqual(expected);
  });

  // ── 逐表比對 ──────────────────────────────────────────────────────────────
  for (const table of drizzleTables) {
    const cfg = getTableConfig(table);

    it(`${cfg.name}:欄位(名稱/型別/NOT NULL/PK/DEFAULT)一致`, async () => {
      const info = (
        await db().prepare(`PRAGMA table_info('${cfg.name}')`).all<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>()
      ).results;
      const byName = new Map(info.map((c) => [c.name, c]));

      expect(info.map((c) => c.name).sort()).toEqual(
        cfg.columns.map((c) => c.name).sort(),
      );

      for (const col of cfg.columns as SQLiteColumn[]) {
        const actual = byName.get(col.name)!;
        const label = `${cfg.name}.${col.name}`;
        expect(actual.type.toUpperCase(), `${label} 型別`).toBe(
          col.getSQLType().toUpperCase(),
        );
        expect(actual.pk > 0, `${label} PK`).toBe(col.primary);
        // PK 欄跳過 NOT NULL 比對:drizzle 生成的 DDL 會補 NOT NULL,手寫檔
        // 慣用裸 `TEXT PRIMARY KEY`(SQLite 的 TEXT PK 理論上可 NULL —— 應用層
        // 一律給 id,歷史 migration 是 append-only,不回頭改)。
        if (!col.primary)
          expect(actual.notnull === 1, `${label} NOT NULL`).toBe(col.notNull);
        if (col.hasDefault && (typeof col.default === "string" || typeof col.default === "number")) {
          expect(actual.dflt_value, `${label} DEFAULT`).toBe(sqlLiteral(col.default));
        } else if (!col.hasDefault) {
          expect(actual.dflt_value, `${label} 不該有 DEFAULT`).toBeNull();
        }
      }
    });

    it(`${cfg.name}:外鍵一致(含 ON DELETE 行為)`, async () => {
      const rows = (
        await db().prepare(`PRAGMA foreign_key_list('${cfg.name}')`).all<{
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }>()
      ).results;
      const actual = rows
        .map((r) => `${r.from} -> ${r.table}.${r.to} on_delete=${r.on_delete.toLowerCase()}`)
        .sort();
      const expected = cfg.foreignKeys
        .map((fk) => {
          const ref = fk.reference();
          return `${ref.columns[0].name} -> ${getTableName(ref.foreignTable)}.${ref.foreignColumns[0].name} on_delete=${fk.onDelete ?? "no action"}`;
        })
        .sort();
      expect(actual).toEqual(expected);
    });

    it(`${cfg.name}:索引一致(名稱/UNIQUE/欄位/partial)`, async () => {
      const list = (
        await db().prepare(`PRAGMA index_list('${cfg.name}')`).all<{
          name: string;
          unique: number;
          origin: string; // 'c' = CREATE INDEX;'pk'/'u' = 內建約束
          partial: number;
        }>()
      ).results.filter((i) => i.origin === "c");

      // 期望 = extra-config 宣告的索引 + 欄位級 .unique()(drizzle 生成
      // `<table>_<col>_unique` 的顯式 CREATE UNIQUE INDEX,如 users_email_unique)。
      const expected = new Map<
        string,
        { unique: boolean; columns: string[]; where: string | undefined }
      >();
      for (const idx of indexConfigs(table)) {
        const cols = idx.columns.map((c) => {
          const name = (c as SQLiteColumn).name;
          if (typeof name !== "string")
            throw new Error(`${idx.name}:SQL expression 欄位,需擴充比對器`);
          return name;
        });
        expected.set(idx.name, {
          unique: idx.unique,
          columns: cols,
          where: idx.where
            ? normalizePredicate(
                dialect.sqlToQuery(idx.where.inlineParams()).sql,
                cfg.name,
              )
            : undefined,
        });
      }
      for (const col of cfg.columns as SQLiteColumn[]) {
        if (col.isUnique)
          expected.set(col.uniqueName ?? `${cfg.name}_${col.name}_unique`, {
            unique: true,
            columns: [col.name],
            where: undefined,
          });
      }

      // PRAGMA index_list 只說 partial 與否,述詞本身要去 sqlite_master 拿 DDL。
      const ddlByName = new Map(
        (
          await db()
            .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ?")
            .bind(cfg.name)
            .all<{ name: string; sql: string | null }>()
        ).results.map((r) => [r.name, r.sql]),
      );

      expect(
        list.map((i) => i.name).sort(),
        `${cfg.name} 的索引集合(DB 多出 = migration 建了但 schema.ts 沒宣告;缺 = schema.ts 宣告了但 migration 沒建)`,
      ).toEqual([...expected.keys()].sort());

      for (const idx of list) {
        const want = expected.get(idx.name)!;
        expect(idx.unique === 1, `${idx.name} UNIQUE`).toBe(want.unique);
        expect(idx.partial === 1, `${idx.name} partial(WHERE 述詞有無)`).toBe(
          want.where !== undefined,
        );
        if (want.where !== undefined) {
          const ddl = ddlByName.get(idx.name);
          const m = /\sWHERE\s+([\s\S]+)$/i.exec(ddl ?? "");
          expect(m, `${idx.name}:sqlite_master 讀不到 WHERE 述詞(DDL:${ddl})`).toBeTruthy();
          expect(
            normalizePredicate(m![1], cfg.name),
            `${idx.name} partial 述詞(migration 的 WHERE 與 schema.ts 的 .where() 必須是同一個條件)`,
          ).toBe(want.where);
        }
        const cols = (
          await db().prepare(`PRAGMA index_info('${idx.name}')`).all<{
            seqno: number;
            name: string;
          }>()
        ).results
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => c.name);
        // 只比欄位與順序,不比排序方向(agent_audit_at_desc / storage_history_at_desc
        // 的 DESC 在 index_info 看不到,而本版 drizzle 也宣告不了 —— schema.ts 註明)。
        expect(cols, `${idx.name} 欄位`).toEqual(want.columns);
      }
    });
  }

  // ── content_fts(schema.ts 描述不了的那一張)────────────────────────────────
  it("content_fts:0011 重建後的欄位形狀,且 FTS5 在 workerd D1 上真的可寫可查", async () => {
    const cols = (
      await db().prepare("PRAGMA table_info('content_fts')").all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(cols).toEqual(["content_id", "type_key", "locale", "title", "body"]);

    await db()
      .prepare(
        "INSERT INTO content_fts (content_id, type_key, locale, title, body) VALUES ('mp-1', 'blog.post', 'en', 'hello parity', 'body text')",
      )
      .run();
    const hits = (
      await db()
        .prepare("SELECT content_id FROM content_fts WHERE content_fts MATCH 'parity'")
        .all<{ content_id: string }>()
    ).results;
    expect(hits.map((h) => h.content_id)).toEqual(["mp-1"]);
  });
});
