/**
 * Regenerates registry/schema/manifest.schema.json (mirrored into both the
 * su-registry and registry repos) from the zod source of truth in
 * src/ext/dx/manifest.ts (manifestSchema).
 *
 * Why this exists: `z.toJSONSchema()` alone loses two kinds of information
 * that hand-authors previously had to patch in by hand (and regularly forgot
 * to keep in sync):
 *
 *   1. `.refine()` / `.superRefine()` semantics. zod silently drops these
 *      when converting to JSON Schema -- no error, no warning, just gone.
 *      Every refine in manifest.ts is re-derived here as `if`/`then`/`not`
 *      (where JSON Schema draft 2020-12 can express it) or documented via
 *      `description` (where it can't -- e.g. superRefine cross-field
 *      checks, which need sibling-array lookups JSON Schema has no keyword
 *      for).
 *   2. A readable `$defs` structure. Raw `z.toJSONSchema` output inlines
 *      every nested object schema at every call site (leafField ends up
 *      duplicated 4x, for example). This script factors out the same named
 *      shapes the hand-written schema used, sourcing every *value* (pattern,
 *      enum, required list, bounds) straight from zod's own output so drift
 *      in manifest.ts is picked up automatically on next run.
 *
 * manifest.ts is READ-ONLY here -- this script never asks zod to change how
 * it validates, only how the mirror describes what zod already does.
 *
 * Usage:
 *   npx tsx scripts/gen-manifest-schema.mts            # write both mirrors
 *   npx tsx scripts/gen-manifest-schema.mts --check     # diff only, exit 1 on drift
 *   node scripts/gen-manifest-schema.mts                # also works (Node 22.6+/23+ strips TS types natively)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import path from "node:path";
import { z } from "zod";

// manifest.ts uses the codebase's extensionless relative imports (bundler
// resolution), e.g. `import { validateSvg } from "./svg-guard"`. Node's native
// TS type-stripping requires an explicit extension for relative specifiers, so
// a bare `node scripts/gen-manifest-schema.mts` would fail to resolve them. This
// synchronous resolve hook appends `.ts` to extensionless relative imports when
// a matching file exists, leaving bare (node_modules) specifiers untouched. It
// must be registered BEFORE manifest.ts is loaded, so manifest.ts is imported
// dynamically below (static imports evaluate before this module's body runs).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[cm]?[jt]sx?$/.test(specifier) &&
      context.parentURL
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { manifestSchema } = await import("../src/ext/dx/manifest.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CMS_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CMS_ROOT, "..");

const OUTPUT_PATHS = [
  path.join(REPO_ROOT, "su-registry", "schema", "manifest.schema.json"),
  path.join(REPO_ROOT, "registry", "schema", "manifest.schema.json"),
];

// ---- tiny JSON-tree helpers (immutable-style: every helper returns a new
// value rather than mutating its input, per repo coding style) ----

type Json = unknown;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function get(root: Json, pathSegs: (string | number)[]): Json {
  return pathSegs.reduce<Json>((node, seg) => {
    if (node == null || typeof node !== "object") {
      throw new Error(`gen-manifest-schema: path segment "${seg}" missing (assumption about manifest.ts shape drifted)`);
    }
    // @ts-expect-error -- indexing into an untyped JSON tree by design
    return node[seg];
  }, root);
}

function set(root: Json, pathSegs: (string | number)[], value: Json): Json {
  if (pathSegs.length === 0) return value;
  const [head, ...rest] = pathSegs;
  if (Array.isArray(root)) {
    const copy = root.slice();
    copy[head as number] = set(copy[head as number], rest, value);
    return copy;
  }
  const obj = { ...(root as Record<string, Json>) };
  obj[head as string] = set(obj[head as string], rest, value);
  return obj;
}

/** Canonicalize (sort object keys recursively) so structurally-identical
 * nodes produce identical strings regardless of property insertion order. */
function canon(value: Json): Json {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value as Record<string, Json>).sort()) {
      out[key] = canon((value as Record<string, Json>)[key]);
    }
    return out;
  }
  return value;
}

function sig(value: Json): string {
  return JSON.stringify(canon(value));
}

/** Replace every subtree of `root` that is structurally identical to
 * `targetSig` with a fresh clone of `replacement`. Matches top-down and does
 * not recurse into a replaced node (once swapped for a $ref, its former
 * contents are gone from this tree -- they live under $defs instead). */
function replaceAll(root: Json, targetSig: string, replacement: Json): Json {
  if (root && typeof root === "object") {
    if (!Array.isArray(root) && sig(root) === targetSig) {
      return clone(replacement);
    }
    if (Array.isArray(root)) {
      return root.map((child) => replaceAll(child, targetSig, replacement));
    }
    const out: Record<string, Json> = {};
    for (const key of Object.keys(root as Record<string, Json>)) {
      out[key] = replaceAll((root as Record<string, Json>)[key], targetSig, replacement);
    }
    return out;
  }
  return root;
}

/** Recursively strip `format` keys. ajv-cli's draft2020 spec mode has no
 * validator registered for "format": "email" (that needs the separate
 * ajv-formats package) and treats an unrecognized format as a hard schema
 * compile error under strict mode. zod already encodes the equivalent
 * constraint as a `pattern` alongside `format`, so dropping `format` loses
 * nothing -- the regex keeps doing the actual validation work. */
function stripFormat(node: Json): Json {
  if (Array.isArray(node)) return node.map(stripFormat);
  if (node && typeof node === "object") {
    const out: Record<string, Json> = {};
    for (const [key, value] of Object.entries(node as Record<string, Json>)) {
      if (key === "format") continue;
      out[key] = stripFormat(value);
    }
    return out;
  }
  return node;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`gen-manifest-schema assumption failed: ${message}`);
  }
}

// ---- step 1: ask zod for the ground truth ----
// io:"input" (not the "output" default) matters: several manifest.ts objects
// (author, support, og, og.image, installPrompts[]) deliberately don't call
// .strict(), so at parse time zod *accepts* (and silently drops) unknown
// keys on them. z.toJSONSchema's default io:"output" describes the shape
// *after* parsing, which -- for a strip-mode object -- never has extra keys,
// so it emits additionalProperties:false there too. That's wrong for a
// schema meant to validate the raw manifest.json *input* document. io:"input"
// correctly omits additionalProperties on those non-strict objects while
// still keeping it false everywhere manifest.ts calls .strict().
const rawGenerated = z.toJSONSchema(manifestSchema, {
  target: "draft-2020-12",
  unrepresentable: "any",
  io: "input",
});

let root: Json = stripFormat(clone(rawGenerated));

// ---- step 2: extract leaf-level reused patterns/enums into $defs ----
// Each canonical path below points at one live occurrence in the *current*
// tree at the time it runs (steps execute in dependency order, leaves
// first). replaceAll then sweeps every other occurrence -- known ones are
// asserted below as a tripwire for drift, but replaceAll itself does not
// depend on the list being exhaustive.

// 每個片段都會依路徑動態改寫，保留其原有 JSON Schema 結構，避免把 runtime schema
// 誤窄化成不正確的靜態型別。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 動態 JSON Schema 片段的屬性由 zod 在 runtime 決定。
type MutableSchema = Record<string, any>;

const defs: Record<string, MutableSchema> = {};

function extractLeaf(name: string, canonicalPath: (string | number)[], expect: (v: Json) => void) {
  const value = get(root, canonicalPath);
  expect(value);
  defs[name] = clone(value) as MutableSchema;
  root = replaceAll(root, sig(value), { $ref: `#/$defs/${name}` });
}

const leafFieldTypeEnum = [
  "text", "richtext", "number", "boolean", "date", "media", "select", "slug", "json", "relation", "relations",
];

extractLeaf("fieldKey", ["properties", "contentTypes", "items", "properties", "fields", "items", "anyOf", 0, "properties", "key"], (v) => {
  assert((v as MutableSchema).type === "string" && typeof (v as MutableSchema).pattern === "string", "leaf field `key` is not a plain patterned string");
});

extractLeaf("typeName", ["properties", "contentTypes", "items", "properties", "name"], (v) => {
  assert((v as MutableSchema).type === "string" && typeof (v as MutableSchema).pattern === "string", "contentType.name is not a plain patterned string");
});

extractLeaf("relationTo", ["properties", "contentTypes", "items", "properties", "fields", "items", "anyOf", 0, "properties", "to"], (v) => {
  assert((v as MutableSchema).type === "string" && typeof (v as MutableSchema).pattern === "string", "leaf field `to` is not a plain patterned string");
});

extractLeaf("routePattern", ["properties", "publicRoutes", "items", "properties", "pattern"], (v) => {
  assert((v as MutableSchema).type === "string" && typeof (v as MutableSchema).pattern === "string", "publicRoute.pattern is not a plain patterned string");
});

extractLeaf("listLayout", ["properties", "adminPages", "items", "properties", "layout"], (v) => {
  assert(Array.isArray((v as MutableSchema).enum) && (v as MutableSchema).enum.length === 3, "adminPage.layout enum shape drifted");
});

extractLeaf("themeColor", ["properties", "theme", "properties", "accent"], (v) => {
  assert((v as MutableSchema).type === "string" && typeof (v as MutableSchema).pattern === "string", "theme.accent is not a plain patterned string");
});

extractLeaf("themeRadius", ["properties", "theme", "properties", "radius"], (v) => {
  assert((v as MutableSchema).type === "string" && typeof (v as MutableSchema).pattern === "string", "theme.radius is not a plain patterned string");
});

// ---- step 3: leafField (the 08 §1/§2 single-value field shape), reused as
// a top-level union member AND as the nested-subfield shape of
// group/repeater/blocks (leaf-only nesting, v1). Re-derive the 3
// leafFieldSchema.refine() checks that z.toJSONSchema drops silently:
//   - select requires non-empty `options`
//   - relation/relations require `to`; every other type must NOT have `to`
//   - `multiline` is only valid on type:"text"
{
  const canonicalPath = ["properties", "contentTypes", "items", "properties", "fields", "items", "anyOf", 0];
  const raw = get(root, canonicalPath) as MutableSchema;
  assert(raw.type === "object" && raw.properties?.type?.enum?.length === leafFieldTypeEnum.length, "leafField shape drifted");
  const patched = clone(raw);
  patched.description =
    "A leaf (single-value) field. Usable as a top-level field AND as a nested subfield of group/repeater/blocks. Structural types are NOT leaf fields (a structural field may not nest another structural field -- one level of nesting only, v1).";
  patched.allOf = [
    {
      if: { properties: { type: { const: "select" } }, required: ["type"] },
      then: { required: ["key", "type", "options"] },
    },
    {
      if: { properties: { type: { enum: ["relation", "relations"] } }, required: ["type"] },
      then: { required: ["key", "type", "to"] },
      else: { not: { required: ["to"] } },
    },
    {
      if: { not: { properties: { type: { const: "text" } }, required: ["type"] } },
      then: { not: { required: ["multiline"] } },
    },
  ];
  defs.leafField = patched;
  root = replaceAll(root, sig(raw), { $ref: "#/$defs/leafField" });
}

// leafFields: the >=1 array of leaf subfields shared by group/repeater/blockDef.
{
  const canonicalPath = ["properties", "contentTypes", "items", "properties", "fields", "items", "anyOf", 1, "properties", "fields"];
  const raw = get(root, canonicalPath) as MutableSchema;
  assert(raw.type === "array" && raw.minItems === 1 && raw.items?.$ref === "#/$defs/leafField", "leafFields shape drifted");
  defs.leafFields = clone(raw);
  root = replaceAll(root, sig(raw), { $ref: "#/$defs/leafFields" });
}

// ---- step 4: the three structural field types + blockDef (each appears
// once in the raw tree, but are pulled into $defs anyway for the same
// readability reason the hand-written baseline did: they're conceptually
// named shapes, not incidental structure). ----
{
  const groupPath = ["properties", "contentTypes", "items", "properties", "fields", "items", "anyOf", 1];
  const group = clone(get(root, groupPath)) as MutableSchema;
  assert(group.properties?.type?.const === "group", "groupField shape drifted");
  group.description =
    "Tier 2 v1.2: nested fieldset. Stored value: { ...subfield values }. Its `fields` are leaf fields only (one level of nesting).";
  defs.groupField = group;
  root = set(root, groupPath, { $ref: "#/$defs/groupField" });

  const repeaterPath = ["properties", "contentTypes", "items", "properties", "fields", "items", "anyOf", 2];
  const repeater = clone(get(root, repeaterPath)) as MutableSchema;
  assert(repeater.properties?.type?.const === "repeater", "repeaterField shape drifted");
  repeater.description =
    "Tier 2 v1.2: sortable ordered list of groups. Stored value: [{ ... }, ...]. Its `fields` are leaf fields only (one level of nesting). Optional `max` caps the row count.";
  defs.repeaterField = repeater;
  root = set(root, repeaterPath, { $ref: "#/$defs/repeaterField" });

  const blocksPath = ["properties", "contentTypes", "items", "properties", "fields", "items", "anyOf", 3];
  const blocksField = clone(get(root, blocksPath)) as MutableSchema;
  assert(blocksField.properties?.type?.const === "blocks", "blocksField shape drifted");
  assert(blocksField.properties?.blocks?.items?.type === "object", "blockDef nested inside blocksField shape drifted");

  const blockDef = clone(blocksField.properties.blocks.items) as MutableSchema;
  blockDef.description = "One named block shape declared by a blocks field. Its `fields` are leaf fields only.";
  defs.blockDef = blockDef;
  blocksField.properties.blocks.items = { $ref: "#/$defs/blockDef" };
  blocksField.description =
    "Tier 2 v1.2: block-type chooser + repeater, the declarable page-builder primitive. Stored value: [{ block: '<name>', ...fields }, ...]. Declares named block shapes; each block's `fields` are leaf fields only. Optional `max` caps the instance count.";
  defs.blocksField = blocksField;
  root = set(root, blocksPath, { $ref: "#/$defs/blocksField" });
}

// field: top-level union of leaf | group | repeater | blocks. zod emits
// anyOf; the hand-written baseline used oneOf (the four branches are made
// mutually exclusive by their own required/const constraints, so oneOf is
// strictly correct here and slightly tighter than anyOf).
{
  const fieldsItemsPath = ["properties", "contentTypes", "items", "properties", "fields", "items"];
  defs.field = {
    description:
      "A top-level content-type field: any leaf field, or a Tier 2 structural field (group/repeater/blocks). Structural fields contain leaf fields only (one level of nesting, v1).",
    oneOf: [
      { $ref: "#/$defs/leafField" },
      { $ref: "#/$defs/groupField" },
      { $ref: "#/$defs/repeaterField" },
      { $ref: "#/$defs/blocksField" },
    ],
  };
  root = set(root, fieldsItemsPath, { $ref: "#/$defs/field" });
}

// ---- step 5: form layout (progressive layout §, contentTypeSchema nested)
// formLayoutSchema.refine(): kind:"manual" requires >=1 groups. ----
{
  const columnPath = ["properties", "contentTypes", "items", "properties", "layout", "properties", "groups", "items"];
  const column = clone(get(root, columnPath));
  defs.formLayoutColumn = column;
  root = replaceAll(root, sig(column), { $ref: "#/$defs/formLayoutColumn" });

  const layoutPath = ["properties", "contentTypes", "items", "properties", "layout"];
  const layout = clone(get(root, layoutPath)) as MutableSchema;
  assert(layout.properties?.kind?.enum?.includes("manual"), "formLayout shape drifted");
  layout.description =
    "Progressive form layout. 'auto2col' = declarative baseline (full-row tall fields, paired short fields). 'single' = single column stack. 'manual' = author-defined groups; keys are field names that must exist on this content type. manual layout requires groups (zod refine: at least one group when kind='manual').";
  layout.if = { properties: { kind: { const: "manual" } }, required: ["kind"] };
  layout.then = { required: ["kind", "groups"], properties: { groups: { type: "array", minItems: 1 } } };
  defs.formLayout = layout;
  root = replaceAll(root, sig(get(root, layoutPath)), { $ref: "#/$defs/formLayout" });
}

// contentType (contentTypeSchema): no own refine, but nests `name` (typeName)
// and `layout` (formLayout), both already $ref'd above.
{
  const contentTypePath = ["properties", "contentTypes", "items"];
  const contentType = clone(get(root, contentTypePath));
  defs.contentType = contentType;
  root = set(root, ["properties", "contentTypes", "items"], { $ref: "#/$defs/contentType" });
}

// ---- step 6: settings (select requires options; non-select forbids them) ----
{
  const optionPath = ["properties", "settings", "items", "properties", "options", "items"];
  const option = clone(get(root, optionPath));
  defs.settingOption = option;
  root = replaceAll(root, sig(option), { $ref: "#/$defs/settingOption" });

  const settingPath = ["properties", "settings", "items"];
  const setting = clone(get(root, settingPath)) as MutableSchema;
  assert(setting.properties?.type?.enum?.includes("select"), "settingField shape drifted");
  setting.description =
    "Same shape as the code extension SettingField. Select option values must be unique; secret defaults must be empty. Using required:true requires coreApi with a minimum version of 1.18.0. These cross-value/version semantics are enforced by manifestSchema (authoritative).";
  setting.properties.key = { $ref: "#/$defs/fieldKey" };
  setting.if = { properties: { type: { const: "select" } }, required: ["type"] };
  setting.then = {
    required: ["key", "label", "default", "type", "options"],
    properties: { options: { type: "array", minItems: 1 } },
  };
  setting.else = { not: { required: ["options"] } };
  defs.settingField = setting;
  root = set(root, settingPath, { $ref: "#/$defs/settingField" });
}

// adminPage (adminPageSchema): no refine, layout already $ref'd to listLayout.
{
  const adminPagePath = ["properties", "adminPages", "items"];
  defs.adminPage = clone(get(root, adminPagePath));
  root = set(root, adminPagePath, { $ref: "#/$defs/adminPage" });
}

// ---- step 7: public routes ----
// publicRouteSchema has THREE refines: `layout` only valid when view:"list",
// `success` only valid when view:"form", `stepped` only valid when
// view:"form". (The hand-written baseline only encoded `stepped` as a real
// constraint and left layout/success as description-only notes -- this is a
// closeable gap, not a deliberate design choice, so all three are encoded
// here as real if/then constraints. This tightens validation relative to
// the previous hand-written mirror; it cannot reject any manifest that
// zod's actual runtime check would accept.)
{
  const successPath = ["properties", "publicRoutes", "items", "properties", "success"];
  defs.formSuccess = clone(get(root, successPath));
  root = replaceAll(root, sig(get(root, successPath)), { $ref: "#/$defs/formSuccess" });

  const publicRoutePath = ["properties", "publicRoutes", "items"];
  const publicRoute = clone(get(root, publicRoutePath)) as MutableSchema;
  assert(publicRoute.properties?.view?.enum?.includes("form"), "publicRoute shape drifted");
  publicRoute.properties.layout = {
    allOf: [{ $ref: "#/$defs/listLayout" }],
    description: "list view only. Absent = table (back-compat).",
  };
  publicRoute.properties.success = {
    allOf: [{ $ref: "#/$defs/formSuccess" }],
    description: "form view only: submission success feedback.",
  };
  publicRoute.description =
    "Alpha: 'form' = anonymous public form submission (uses contentType + public:true).";
  publicRoute.allOf = [
    {
      if: { not: { properties: { view: { const: "list" } }, required: ["view"] } },
      then: { not: { required: ["layout"] } },
    },
    {
      if: { not: { properties: { view: { const: "form" } }, required: ["view"] } },
      then: { not: { required: ["success"] } },
    },
    {
      if: { not: { properties: { view: { const: "form" } }, required: ["view"] } },
      then: { not: { required: ["stepped"] } },
    },
  ];
  defs.publicRoute = publicRoute;
  root = set(root, publicRoutePath, { $ref: "#/$defs/publicRoute" });
}

// ---- step 8: hooks (hook names are an allowlist in manifestSchema) ----
{
  const hookActionPath = ["properties", "on", "additionalProperties", "items"];
  defs.hookAction = clone(get(root, hookActionPath));
  root = set(root, hookActionPath, { $ref: "#/$defs/hookAction" });
  const onPath = ["properties", "on"];
  const on = clone(get(root, onPath)) as MutableSchema;
  on.propertyNames = {
    enum: [
      "ext:enabled",
      "ext:disabled",
      "user:created",
      "settings:saved",
      "storage:uploaded",
      "content:created",
      "content:updated",
      "content:deleted",
      "payment:succeeded",
      "extraction:completed",
    ],
  };
  root = set(root, onPath, on);
}

// ---- step 9: install prompts (cross-checked against settings[] via
// manifestSchema.superRefine -- not expressible in JSON Schema, documented
// via description instead) ----
{
  const installPromptPath = ["properties", "installPrompts", "items"];
  const installPrompt = clone(get(root, installPromptPath)) as MutableSchema;
  installPrompt.description = "zod does not call .strict() on this object, so additional properties are permitted here.";
  installPrompt.properties.key.description = "Must reference an existing settings[].key (zod superRefine cross-check).";
  installPrompt.properties.secret.description = "Must match the referenced settings[].secret flag (zod superRefine cross-check).";
  installPrompt.properties.type.description =
    "Must match the referenced settings[].type (zod superRefine cross-check).";
  defs.installPrompt = installPrompt;
  root = set(root, installPromptPath, { $ref: "#/$defs/installPrompt" });
}

// customApiRoute (customApiRouteSchema: no refine; .strict())
{
  const customApiRoutePath = ["properties", "customApiRoutes", "items"];
  const customApiRoute = clone(get(root, customApiRoutePath)) as MutableSchema;
  customApiRoute.properties.method.description =
    "read-only v1: only GET is accepted. Older core versions accepted POST/PUT/DELETE; consumers using this field must declare coreApi ^1.9.0.";
  customApiRoute.properties.contentType.description =
    "Points at a content type declared by this same extension (local name). Listing it here marks that type as publicly exposed.";
  customApiRoute.properties.responseShape.description = "Documentation-only; not enforced at runtime.";
  defs.customApiRoute = customApiRoute;
  root = set(root, customApiRoutePath, { $ref: "#/$defs/customApiRoute" });
}

// requiresEntry (no refine)
{
  const requiresEntryPath = ["properties", "requires", "items"];
  const requiresEntry = clone(get(root, requiresEntryPath)) as MutableSchema;
  requiresEntry.properties.capability.description =
    "Provider capability name, matching providers.ts convention: 'name' or 'name:verb' (lowercase/digits/hyphens).";
  requiresEntry.properties.optional.description =
    "true = install may proceed without this provider present (UI shows a suggestion). Absent/false = missing provider blocks install.";
  requiresEntry.properties.reason.description = "User-facing explanation shown in the Browse UI's capability chips tooltip.";
  defs.requiresEntry = requiresEntry;
  root = set(root, requiresEntryPath, { $ref: "#/$defs/requiresEntry" });
}

// ---- step 10: theme (themeColorSchema/themeRadiusSchema .refine() is a
// redundant injection-character guard -- the regex character classes
// already exclude ; { } < > " ', so there is nothing left for a JSON Schema
// `not: pattern` to additionally reject; documented instead of duplicated) ----
{
  defs.themeColor.description =
    "Hex or oklch()/rgb()/hsl(...) color. Must not contain ; { } < > \" ' (defense-in-depth against inline-style injection, on top of the character-class regex).";
  defs.themeRadius.description =
    "<number>px or <number>rem. Same injection-safety note as themeColor applies (character set already excludes the dangerous characters).";

  const themePath = ["properties", "theme"];
  const theme = clone(get(root, themePath)) as MutableSchema;
  theme.description =
    "1.8.0: optional design tokens rendered into public pages as inline CSS custom properties (--ext-accent / --ext-bg / --ext-muted / --ext-radius). Admin ignores this. All fields optional.";
  defs.theme = theme;
  root = set(root, themePath, { $ref: "#/$defs/theme" });
}

// ---- step 11: migrations (two refines dropped by z.toJSONSchema: no
// inline ';', and must contain CREATE (TABLE|UNIQUE INDEX|INDEX) ... IF NOT
// EXISTS). zod's `.test()` is case-insensitive; JSON Schema `pattern` has no
// portable case-insensitivity flag in draft 2020-12, so -- matching the
// previous hand-written mirror's documented, deliberate limitation -- authors
// must write the DDL verb in uppercase for schema validation to accept it
// (zod itself remains case-insensitive; this is a JSON-Schema-side
// over-restriction, not a loosening). ----
{
  const migrationPath = ["properties", "migrations", "items"];
  const migration = clone(get(root, migrationPath)) as MutableSchema;
  migration.pattern = "CREATE\\s+(TABLE|UNIQUE\\s+INDEX|INDEX)\\s+IF\\s+NOT\\s+EXISTS";
  migration.not = { pattern: ";" };
  migration.description =
    "Single idempotent DDL statement. Must contain 'CREATE (TABLE|UNIQUE INDEX|INDEX) ... IF NOT EXISTS' (case-insensitive in zod; JSON Schema regex here is applied case-sensitively per draft2020 defaults, author in uppercase) and must not contain ';' anywhere (no multi-statement strings).";
  defs.migrationStatement = migration;
  root = set(root, migrationPath, { $ref: "#/$defs/migrationStatement" });
}

// ---- step 12: dashboard cards ----
// dashboardCardSchema has two refines (`status` only on kind:"stat", `limit`
// only on kind:"recent") plus a manifestSchema.superRefine cross-check
// against contentTypes[].name (not expressible in JSON Schema; documented).
{
  const dashboardCardPath = ["properties", "dashboardCards", "items"];
  const dashboardCard = clone(get(root, dashboardCardPath)) as MutableSchema;
  assert(dashboardCard.properties?.kind?.enum?.includes("stat"), "dashboardCard shape drifted");
  dashboardCard.description =
    "roadmap #16: one extension-contributed dashboard card. kind='stat' shows the entry count for a content type (optionally filtered by status); kind='recent' shows the most recently updated entries (limit 1..10, default 5). `status` is stat-only, `limit` is recent-only (zod refine).";
  dashboardCard.properties.contentType.description =
    "Must reference a declared contentTypes[].name (zod superRefine cross-check; not expressible in JSON Schema).";
  dashboardCard.properties.title.description = "Absent -> falls back to the referenced contentType's label/name.";
  dashboardCard.properties.status.description = "stat cards only: count only entries with this status.";
  dashboardCard.properties.limit.description = "recent cards only: number of entries returned, default 5.";
  dashboardCard.allOf = [
    {
      if: { not: { properties: { kind: { const: "stat" } }, required: ["kind"] } },
      then: { not: { required: ["status"] } },
    },
    {
      if: { not: { properties: { kind: { const: "recent" } }, required: ["kind"] } },
      then: { not: { required: ["limit"] } },
    },
  ];
  defs.dashboardCard = dashboardCard;
  root = set(root, dashboardCardPath, { $ref: "#/$defs/dashboardCard" });
}

// ---- step 12b: schedule (B: docs/spec-declarative-notify-schedule.md --
// declarative scheduled actions riding the ext-jobs surface, docs/spec-extension-jobs.md).
// scheduleSchema has an array-level refine (unique `id` across items) that
// z.toJSONSchema drops silently -- not expressible in JSON Schema, documented
// via description instead (same pattern as dashboardCards' cross-array checks). ----
{
  const scheduleActionPath = ["properties", "schedule", "items", "properties", "action"];
  const scheduleAction = clone(get(root, scheduleActionPath)) as MutableSchema;
  assert(scheduleAction.properties?.op?.const === "deleteOlderThan", "scheduleAction shape drifted");
  scheduleAction.description =
    "v1 has a single op: deleteOlderThan. `contentType` must name a contentTypes[].name declared by this same manifest (enforced by zod superRefine; not expressible in JSON Schema).";
  defs.scheduleAction = scheduleAction;
  root = set(root, scheduleActionPath, { $ref: "#/$defs/scheduleAction" });

  const scheduleItemPath = ["properties", "schedule", "items"];
  const scheduleItem = clone(get(root, scheduleItemPath)) as MutableSchema;
  scheduleItem.description =
    "One declarative scheduled action, interpreted into an Extension.jobs entry and executed by the ext-jobs core job (docs/spec-extension-jobs.md). `id` must be unique across schedule[] (zod array refine; not expressible in JSON Schema).";
  defs.scheduleItem = scheduleItem;
  root = set(root, scheduleItemPath, { $ref: "#/$defs/scheduleItem" });
}

// ---- step 13: top-level property descriptions that carry cross-field or
// non-regex-expressible semantics (installPrompts[].key <-> settings[].key,
// dashboardCards[].contentType <-> contentTypes[].name superRefine checks) ----
{
  const p = (root as MutableSchema).properties;
  p.installPrompts.description =
    "Fields to prompt the installing user for (marketplace shows a form). Each entry's `key` must reference an existing settings[].key with a matching `secret` flag (zod superRefine cross-check; not expressible in JSON Schema).";
  p.dashboardCards.description =
    "roadmap #16: extension-contributed dashboard cards (stat/recent). Each card's `contentType` must reference a declared contentTypes[].name (zod superRefine cross-check; not expressible in JSON Schema). Adding this field is a CORE_API minor bump (1.5.0 -> 1.6.0): a manifest using it must declare coreApi \"^1.6.0\" or higher, since older core rejects unknown-strict-object fields entirely.";
  p.kind.description =
    "Only 'declarative' manifests are validated by this schema. 'code' extensions (metadata stub with an install command) are a different, unvalidated shape.";
  p.id.description = "Extension id. Full content type keys become '<id>.<typeName>'.";
  p.version.description = "Exact semver x.y.z of this manifest.";
  p.coreApi.description = "Semver range checked against CORE_API_VERSION. Supports ^x.y.z, ~x.y.z, exact, >=x.y.z.";
  p.icon.description = "Declarative extension icon hint (lucide token). Used for admin sidebar / menus.";
  p.iconUrl.description = "PNG icon relative path in registry (e.g. 'icon.png' under extensions/<id>/).";
  p.banner.description = "Top banner image relative path (e.g. 'banner.png').";
  p.screenshots.description = "Screenshots list (relative paths).";
  p.deployment.description =
    "instant = usable immediately; progressive = usable after install but full experience needs a rebuild; code-only = must rebuild.";
  p.files.description =
    "1.25.0: optional code-enhancement layer, as paths relative to the registry's extensions/<id>/files/. The declarative half still hot-installs and works on its own; these files are fetched by `sz-ws-cms add <id>` and only light up after a rebuild + deploy, registering view overrides via the (extId, surfaceId) registry in src/ext/overrides.ts. Removing them falls back to the generic views -- progressive is additive, never a one-way eject. Paths are allow-listed ([a-zA-Z0-9._-] and '/'); zod additionally rejects any '..' segment, which this pattern alone cannot express. A manifest using this field must declare coreApi \"^1.25.0\".";
  p.customApiRoutes.description =
    "1.9.0: custom read-only API endpoints other apps may call. Acts as an allow-list of which content types are exposed publicly. v1 is read-only: method must be 'GET'.";
  p.capabilities.description =
    "Platform capabilities this extension needs (install-time feature-gating, core-v2 roadmap #17). Intentionally not an enum here -- unknown names may come from a newer core version; compared against src/ext/features.ts at install time instead.";
  p.requires.description =
    "Service/provider requirements (deliberately separate axis from capabilities): capabilities is core's static feature table, requires is 'which provider must be present' (providers.ts capability registry, e.g. email:send, cron:tick). A non-optional entry that is absent blocks install; an optional one just surfaces a suggestion in the UI.";
  p.author.description = "zod does not call .strict() on this object, so additional properties are permitted here (unlike most other manifest objects).";
  p.homepage.description = "homepage must be https";
  p.repository.description = "repository must be https";
  p.license.description = "SPDX id (e.g. 'MIT'); display only, not SPDX-validated.";
  p.tags.description = "Discoverability tags: search matching + detail page chips.";
  p.support.description = "zod does not call .strict() on this object, so additional properties are permitted here.";
  p.stylesheet.description =
    "1.8.0: optional co-located stylesheet. v1 fixes the filename as the literal 'style.css' (no arbitrary paths, to prevent path traversal / fetching arbitrary assets). Installed content is validated by validateStylesheet before being stored.";
  p.og.description =
    "Optional Open Graph preview config: which core og-template public routes' preview images use. Neither this object nor og.image calls .strict() in zod, so additional properties are permitted at both levels.";
  if (p.og.properties?.image) {
    p.og.properties.image.properties.template.description = "Core og-template name, corresponds to src/components/og/<slug>.tsx.";
  }
  p.migrations.description =
    "Optional DDL. Each entry is a single idempotent statement that must start with CREATE (TABLE|UNIQUE INDEX|INDEX) ... IF NOT EXISTS. No ';' statement-splitting or inline ';'. DROP/INSERT/UPDATE/ALTER are deferred to v1.1 (needs transaction semantics).";
  p.on.description = "Hook name -> array of declarative action bindings. v1 supports webhook actions only.";
  p.schedule.description =
    "B (docs/spec-declarative-notify-schedule.md, CORE_API 1.11.0): declarative scheduled actions (<=8), interpreted into Extension.jobs and executed by the ext-jobs core job (docs/spec-extension-jobs.md) -- no new engine. Adding this field is a CORE_API minor bump (1.10.0 -> 1.11.0): a manifest using it must declare coreApi \"^1.11.0\" or higher.";
  p.loginProvider.description =
    "spec-login-providers.md §4 (CORE_API 1.16.0): declarative third-party OIDC login. `issuer` is the OIDC issuer (discovery is fetched by the engine); `scopes` defaults to [openid, profile, email]. Client id/secret are NOT declared here -- they use the existing settings[] convention (clientId text, clientSecret secret:true), read by the engine at ext.<extId>.clientId / .clientSecret. button.svg is validated by an allowlist svg-guard at parse time (zod refine, dropped by z.toJSONSchema; the maxLength 4000 pattern is enforced but the tag/attribute allowlist is not expressible in JSON Schema). Adding this field is a CORE_API minor bump (1.14.0 -> 1.16.0, 1.15.0 reserved for extension i18n): a manifest using it must declare coreApi \"^1.16.0\".";
  if (p.loginProvider.properties?.button?.properties?.svg) {
    p.loginProvider.properties.button.properties.svg.description =
      "Optional brand icon. Validated by src/ext/dx/svg-guard.ts (allowlist of svg/g/path/circle/rect/ellipse/line/polyline/polygon/defs/linearGradient/radialGradient/stop/clipPath/title; rejects on*= handlers, <script>, javascript:, href/xlink:href, <foreignObject>, <image>, <use>, <style>, <animate*>, external URLs). Rejection fails manifest validation (fail-loud). Not expressible as a JSON Schema constraint beyond maxLength.";
  }
  root = { ...(root as MutableSchema), properties: p };
}

// contentType's own nested field descriptions
{
  const ct = defs.contentType as MutableSchema;
  ct.properties.name.description = "Local type name. Full type key becomes '<extId>.<name>'.";
  ct.properties.slugField.description = "Key of the field used as the auto-slug source.";
  ct.properties.public.description =
    "Alpha: declares this type public (anonymous POST creates a new entry). dispatch(/api/ext/...) skips requireAuth for POST when the matched type is public:true; origin checks / other guards still apply.";
  ct.properties.notifyOnCreate.description =
    "A (docs/spec-declarative-notify-schedule.md, CORE_API 1.11.0): best-effort notification email sent after a successful public create. Recipient is the core.notifyEmail setting (empty = disabled). Only takes effect when `public` is true.";
  defs.adminPage.properties.slug.description = "'' = extension main admin page.";
  defs.adminPage.properties.contentType.description = "Local content type name (matches a contentTypes[].name).";
  defs.publicRoute.properties.contentType.description = "Local content type name (matches a contentTypes[].name).";
  defs.publicRoute.properties.stepped.description =
    "1.7.0: form view only. Splits the form into a vendored Stepper multi-step flow (<=3 fields per step, last step submits) when the content type has >=4 publicly-renderable fields. Only valid when view is 'form'.";
  defs.hookAction.properties.url.description = "https only; outbound webhook target.";
  defs.hookAction.properties.secretSetting.description =
    "Key of a settings entry (secret:true) used to HMAC-SHA256 sign the payload.";
  defs.formLayout.properties.groups.description =
    "Only valid when kind = 'manual'. Each group's fields render in the listed order; a group's fields all share the same row alignment.";
  defs.formLayout.properties.wide.description = "Default wide keys in manual mode -- these fields always take the full row width.";
  defs.leafField.properties.options.description = "select only.";
  defs.leafField.properties.multiline.description =
    "text only: upgrades the input to a fullscreen textarea overlay (TextFullscreenEditor).";
  defs.relationTo = { ...(defs.relationTo as MutableSchema), description: "relation/relations only: target content type key '<extId>.<typeName>'." };
  defs.routePattern = { ...(defs.routePattern as MutableSchema), description: "Plain segment string with ':param' placeholders only. No regex metacharacters; compiled by the O(n) segment matcher." };
  defs.listLayout = {
    ...(defs.listLayout as MutableSchema),
    description:
      "core-v2 §3.5 listing layout. 'table' (default) = one entry per row; 'grid' = responsive card grid; 'stacked' = vendored StackedList sweep-in animation. Absent = table (back-compat). 'table'/'grid' require coreApi ^1.1.0; 'stacked' requires coreApi ^1.7.0.",
  };
}

// ---- step 14: wrap the whole thing with the envelope + $defs, in a stable
// (baseline-matching) key order for a reviewable diff ----

const DEF_ORDER = [
  "fieldKey", "typeName", "relationTo", "routePattern", "listLayout",
  "leafField", "leafFields", "groupField", "repeaterField", "blockDef", "blocksField", "field",
  "formLayoutColumn", "formLayout", "contentType",
  "settingOption", "settingField", "adminPage",
  "formSuccess", "publicRoute", "hookAction",
  "installPrompt", "customApiRoute", "requiresEntry",
  "themeColor", "themeRadius", "theme",
  "migrationStatement", "dashboardCard",
  "scheduleAction", "scheduleItem",
];

const PROPERTY_ORDER = [
  "kind", "id", "name", "version", "coreApi", "description", "icon", "iconUrl", "banner", "screenshots",
  "deployment", "files", "installPrompts", "customApiRoutes", "capabilities", "requires",
  "author", "homepage", "repository", "license", "tags", "category", "support",
  "theme", "stylesheet", "contentTypes", "settings", "adminPages", "publicRoutes", "og",
  "migrations", "on", "dashboardCards", "schedule", "loginProvider",
];

function orderedDefs(): Record<string, Json> {
  const missing = DEF_ORDER.filter((name) => !(name in defs));
  assert(missing.length === 0, `defs missing after extraction: ${missing.join(", ")}`);
  const out: Record<string, Json> = {};
  for (const name of DEF_ORDER) out[name] = defs[name];
  return out;
}

function orderedProperties(): Record<string, Json> {
  const props = (root as MutableSchema).properties as Record<string, Json>;
  const missing = PROPERTY_ORDER.filter((name) => !(name in props));
  assert(missing.length === 0, `top-level properties missing after extraction: ${missing.join(", ")}`);
  // 反向檢查:zod 有、PROPERTY_ORDER 沒有的欄位。少了這道,在 manifest.ts 新增一個
  // 欄位而忘了列進來,鏡像檔會**靜默少掉那個欄位** —— 而它是 additionalProperties:
  // false 的,所以外部用 JSON Schema 驗證的人會拿到「你這個欄位不合法」,錯得毫無
  // 線索。1.25.0 的 files[] 就是這樣掉的,補上檢查免得下一個人再踩。
  const unlisted = Object.keys(props).filter((name) => !PROPERTY_ORDER.includes(name));
  assert(
    unlisted.length === 0,
    `top-level properties present in manifest.ts but missing from PROPERTY_ORDER: ${unlisted.join(", ")} -- add them (order matters, it is the emitted key order)`,
  );
  const out: Record<string, Json> = {};
  for (const name of PROPERTY_ORDER) out[name] = props[name];
  return out;
}

const final = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://raw.githubusercontent.com/sz-ws/registry/main/schema/manifest.schema.json",
  title: "Suko CMS declarative extension manifest v1",
  description:
    "Mirrors the zod schema in cms/src/ext/dx/manifest.ts (manifestSchema, Core v2 architecture spec section 3.2). Validated at install time AND at interpret time. Generated by cms/scripts/gen-manifest-schema.mts -- do not hand-edit; re-run the script after changing manifest.ts. Zod superRefine cross-checks (cross-array references, uniqueness, credential requirements and related semantic invariants) cannot all be expressed in JSON Schema and are documented on the relevant properties where possible; manifestSchema remains authoritative.",
  type: "object",
  required: (root as MutableSchema).required,
  additionalProperties: false,
  properties: orderedProperties(),
  $defs: orderedDefs(),
};

// ---- step 15: write or check ----

const outputText = `${JSON.stringify(final, null, 2)}\n`;

const checkMode = process.argv.includes("--check");

if (checkMode) {
  let drifted = false;
  for (const outputPath of OUTPUT_PATHS) {
    const existing = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null;
    if (existing !== outputText) {
      drifted = true;
      console.error(`[gen-manifest-schema] drift detected: ${path.relative(REPO_ROOT, outputPath)}`);
    }
  }
  if (drifted) {
    console.error("[gen-manifest-schema] run `npm run gen:schema` in cms/ to update the mirrors.");
    process.exit(1);
  }
  console.log("[gen-manifest-schema] no drift -- both mirrors match manifest.ts.");
} else {
  for (const outputPath of OUTPUT_PATHS) {
    writeFileSync(outputPath, outputText, "utf8");
    console.log(`[gen-manifest-schema] wrote ${path.relative(REPO_ROOT, outputPath)}`);
  }
}
