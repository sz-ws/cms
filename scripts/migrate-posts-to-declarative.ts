// Task #5 §2: NON-DESTRUCTIVE data migration — ext_posts_posts → contents.
//
// Reads every row of the code `posts` extension's table (ext_posts_posts) and
// INSERTS an equivalent row into the generic engine's `contents` table under
// type "blog.post" (the declarative port's id is "blog"). The source table is
// treated as read-only source-of-truth + permanent backup: this script NEVER
// writes to, alters, or drops ext_posts_posts.
//
// Idempotent: the destination content id is DETERMINISTIC — `blog-<sourceId>` —
// so re-running skips any row already migrated (INSERT OR IGNORE on the PK).
// No duplicates, safe to re-run.
//
// Rollback (documented, one line):
//   DELETE FROM contents WHERE type = 'blog.post';
// or pass `--rollback` to this script (see below). Rollback touches ONLY the
// migrated contents rows; ext_posts_posts is never affected.
//
// Field mapping (ext_posts_posts column → contents):
//   id         → deterministic content id "blog-<id>"; original kept in data.sourceId
//   slug       → contents.slug (preserved verbatim; already unique per source)
//   title      → data.title
//   content    → data.body (Tiptap JSON doc via stringToDoc; legacy string/markdown
//                upgraded to paragraph doc — HTML bodies are treated as text, see NOTE)
//   status     → contents.status ("draft" | "published")
//   author_id  → data.author (raw user id string; the code ext resolved this to a
//                name at render time — declarative stores the id; see parity gap list)
//   created_at → contents.createdAt  (epoch ms, unchanged)
//                also → data.publishedAt (the declarative `date` field), so the
//                public detail page can show a date like the old PostPage did
//   updated_at → contents.updatedAt  (epoch ms, unchanged)
//
// NOTE (HTML fidelity): stringToDoc splits on blank lines into paragraphs and
// stores each block as plain text. If a source body contains HTML/markdown
// markup, the markup is preserved as literal text (not parsed into rich nodes).
// A richer HTML→Tiptap parse is a follow-up; flagged in the parity report.
//
// Run (dev, local miniflare D1):
//   node --experimental-strip-types scripts/migrate-posts-to-declarative.ts
//   node --experimental-strip-types scripts/migrate-posts-to-declarative.ts --rollback
// Optional: DB_PATH=<abs .sqlite> to target a specific D1 file.

import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { stringToDoc } from "../src/ext/dx/fields/richtext-schema.ts";

const NEW_ID = "blog";
const TYPE = `${NEW_ID}.post`;

interface SourceRow {
  id: string;
  slug: string;
  title: string;
  content: string;
  status: string;
  author_id: string;
  created_at: number;
  updated_at: number;
}

/** Locate the local miniflare D1 sqlite file (largest .sqlite in the D1 dir). */
function resolveDbPath(): string {
  const explicit = process.env.DB_PATH;
  if (explicit) return explicit;
  const dir = join(
    process.cwd(),
    ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  );
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
    .map((f) => join(dir, f));
  if (candidates.length === 0) {
    throw new Error(`no D1 sqlite found in ${dir}`);
  }
  return candidates[0];
}

function rollback(db: DatabaseSync): void {
  const before = (
    db.prepare(`SELECT count(*) AS n FROM contents WHERE type = ?`).get(TYPE) as
      | { n: number }
      | undefined
  )?.n ?? 0;
  db.prepare(`DELETE FROM contents WHERE type = ?`).run(TYPE);
  console.log(`[rollback] deleted ${before} contents rows of type "${TYPE}".`);
}

function migrate(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT id, slug, title, content, status, author_id, created_at, updated_at
       FROM ext_posts_posts ORDER BY created_at ASC`,
    )
    .all() as unknown as SourceRow[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO contents
       (id, type, slug, status, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const contentId = `${NEW_ID}-${r.id}`;
    const status = r.status === "published" ? "published" : "draft";
    // §2: body string → Tiptap JSON doc (legacy upgrade); reuses the engine's
    // canonical stringToDoc so migrated docs validate identically to editor output.
    const bodyDoc = stringToDoc(r.content ?? "");
    const data: Record<string, unknown> = {
      title: r.title,
      slug: r.slug,
      body: bodyDoc,
      author: r.author_id,
      publishedAt: r.created_at,
      sourceId: r.id,
    };
    const result = insert.run(
      contentId,
      TYPE,
      r.slug,
      status,
      JSON.stringify(data),
      r.created_at,
      r.updated_at,
    );
    if (result.changes > 0) inserted++;
    else skipped++;
  }

  const total = (
    db.prepare(`SELECT count(*) AS n FROM contents WHERE type = ?`).get(TYPE) as
      | { n: number }
      | undefined
  )?.n ?? 0;
  console.log(
    `[migrate] source rows=${rows.length} inserted=${inserted} skipped(existing)=${skipped}`,
  );
  console.log(`[migrate] contents rows of type "${TYPE}" now = ${total}.`);
}

function main(): void {
  const dbPath = resolveDbPath();
  const doRollback = process.argv.includes("--rollback");
  console.log(`[db] ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  try {
    if (doRollback) rollback(db);
    else migrate(db);
  } finally {
    db.close();
  }
}

main();
