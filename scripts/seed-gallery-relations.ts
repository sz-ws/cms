// Task #8 demo seed: add relation/relations fields to the local `gallery`
// declarative extension and wire a couple of published entries together so the
// picker + display resolution can be smoke-tested. LOCAL D1 (miniflare) only.
//
// Idempotent:
//   - the manifest update only appends `relatedItem` (relation) + `similar`
//     (relations) fields if they are not already present;
//   - relation values are written to two specific published entries; re-running
//     just overwrites them with the same values.
//
// Does NOT touch the code `posts` extension or the `blog` declarative type.
//
// Run (dev): node --experimental-strip-types scripts/seed-gallery-relations.ts
// Optional: DB_PATH=<abs .sqlite> to target a specific D1 file.

import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const EXT_ID = "gallery";
const TYPE = `${EXT_ID}.item`;

interface FieldDef {
  key: string;
  type: string;
  label?: string;
  to?: string;
  options?: string[];
  required?: boolean;
}

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
  if (candidates.length === 0) throw new Error(`no D1 sqlite found in ${dir}`);
  return candidates[0];
}

function addRelationFields(db: DatabaseSync): void {
  const row = db
    .prepare(`SELECT manifest FROM declarative_extensions WHERE id = ?`)
    .get(EXT_ID) as { manifest: string } | undefined;
  if (!row) throw new Error(`gallery extension not found in declarative_extensions`);

  const manifest = JSON.parse(row.manifest) as {
    contentTypes?: { name: string; fields: FieldDef[] }[];
  };
  const ct = manifest.contentTypes?.find((c) => c.name === "item");
  if (!ct) throw new Error(`gallery.item content type not found`);

  const has = (key: string) => ct.fields.some((f) => f.key === key);
  let changed = false;
  if (!has("relatedItem")) {
    ct.fields.push({
      key: "relatedItem",
      type: "relation",
      label: "Related item",
      to: TYPE,
    });
    changed = true;
  }
  if (!has("similar")) {
    ct.fields.push({
      key: "similar",
      type: "relations",
      label: "Similar items",
      to: TYPE,
    });
    changed = true;
  }

  if (changed) {
    db.prepare(
      `UPDATE declarative_extensions SET manifest = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(manifest), Date.now(), EXT_ID);
    console.log(`[seed] added relation fields to ${TYPE} manifest.`);
  } else {
    console.log(`[seed] relation fields already present; manifest untouched.`);
  }
}

function seedValues(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT id, data FROM contents WHERE type = ? AND status = 'published'
       ORDER BY updated_at DESC LIMIT 5`,
    )
    .all(TYPE) as { id: string; data: string }[];
  if (rows.length < 3) {
    console.log(`[seed] need >=3 published entries to wire; found ${rows.length}.`);
    return;
  }

  // Entry 0 gets a single relation (→ entry 1) and an ordered relations list
  // (→ entries 2,3,4). Entry 1 gets a single relation back to entry 0.
  const [a, b, c, d, e] = rows;
  const wire = (targetId: string, patch: Record<string, unknown>) => {
    const found = rows.find((r) => r.id === targetId);
    if (!found) return;
    const data = JSON.parse(found.data) as Record<string, unknown>;
    const next = { ...data, ...patch };
    db.prepare(`UPDATE contents SET data = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(next),
      Date.now(),
      targetId,
    );
  };

  wire(a.id, {
    relatedItem: b.id,
    similar: [c.id, d.id, e.id].filter(Boolean),
  });
  wire(b.id, { relatedItem: a.id });

  console.log(
    `[seed] wired relations: ${a.id}.relatedItem=${b.id}, ` +
      `${a.id}.similar=[${[c.id, d.id, e.id].filter(Boolean).join(", ")}], ` +
      `${b.id}.relatedItem=${a.id}`,
  );
}

function main(): void {
  const path = resolveDbPath();
  const db = new DatabaseSync(path);
  console.log(`[seed] db=${path}`);
  addRelationFields(db);
  seedValues(db);
  db.close();
  console.log(`[seed] done.`);
}

main();
