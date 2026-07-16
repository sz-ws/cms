// Task #9 demo seed: install a local declarative extension that exercises the
// Tier 2 v1.2 structural field types (group / repeater / blocks) end-to-end.
// LOCAL D1 (miniflare) only. Does NOT touch the code `posts` extension, the
// `blog` declarative type, or the `gallery` extension.
//
// The `showcase` extension declares one content type (`page`) with:
//   - a `title` (text, slug source)
//   - a `hero` GROUP (heading text + subheading text + image media)
//   - a `faqs` REPEATER (question text + answer richtext), max 5
//   - a `body` BLOCKS field with two block shapes: `quote` and `callout`
// plus an admin collection page and a public detail route, so the whole
// create → validate → store → cell-summary → public-detail loop is smoke-testable.
//
// Idempotent: upserts the manifest row (enabled=1). Re-running just refreshes it.
//
// Run (dev): node --experimental-strip-types scripts/seed-structural-showcase.ts
// Optional: DB_PATH=<abs .sqlite> to target a specific D1 file.

import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const EXT_ID = "showcase";

const MANIFEST = {
  kind: "declarative",
  id: EXT_ID,
  name: "Structural Showcase",
  version: "1.0.0",
  // requires the Tier 2 structural field types (CORE_API 1.3.0).
  coreApi: "^1.3.0",
  description: "Demo of group / repeater / blocks structural fields.",
  contentTypes: [
    {
      name: "page",
      label: "Page",
      slugField: "title",
      fields: [
        { key: "title", type: "text", label: "Title", required: true },
        {
          key: "hero",
          type: "group",
          label: "Hero",
          fields: [
            { key: "heading", type: "text", label: "Heading" },
            { key: "subheading", type: "text", label: "Subheading" },
            { key: "image", type: "media", label: "Image" },
          ],
        },
        {
          key: "faqs",
          type: "repeater",
          label: "FAQs",
          max: 5,
          fields: [
            { key: "question", type: "text", label: "Question" },
            { key: "answer", type: "richtext", label: "Answer" },
          ],
        },
        {
          key: "body",
          type: "blocks",
          label: "Body",
          blocks: [
            {
              name: "quote",
              label: "Quote",
              fields: [
                { key: "text", type: "text", label: "Quote" },
                { key: "cite", type: "text", label: "Attribution" },
              ],
            },
            {
              name: "callout",
              label: "Callout",
              fields: [
                {
                  key: "tone",
                  type: "select",
                  label: "Tone",
                  options: ["info", "warning", "success"],
                },
                { key: "body", type: "richtext", label: "Body" },
              ],
            },
          ],
        },
      ],
    },
  ],
  adminPages: [
    {
      slug: "",
      title: "Pages",
      view: "collection",
      contentType: "page",
    },
  ],
  publicRoutes: [
    { pattern: "/showcase/:slug", view: "detail", contentType: "page" },
  ],
} as const;

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

function main(): void {
  const path = resolveDbPath();
  const db = new DatabaseSync(path);
  console.log(`[seed] db=${path}`);
  const now = Date.now();
  const json = JSON.stringify(MANIFEST);
  db.prepare(
    `INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at)
     VALUES (?, ?, ?, 1, 'seed', ?, ?)
     ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest, version=excluded.version,
       enabled=1, source='seed', updated_at=excluded.updated_at`,
  ).run(EXT_ID, json, MANIFEST.version, now, now);
  console.log(`[seed] installed "${EXT_ID}" declarative extension (enabled).`);
  db.close();
  console.log(`[seed] done. Admin: /admin/ext/${EXT_ID}`);
}

main();
