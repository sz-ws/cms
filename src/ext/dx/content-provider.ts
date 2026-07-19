import { nanoid } from "nanoid";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { contents } from "@/lib/schema";
import type {
  ContentEntry,
  ContentFieldDef,
  ContentProvider,
  ContentQuery,
  ContentTypeDef,
} from "../capabilities";
import type { HookBus } from "../hooks";
import { isTiptapDoc, isValidRichtextDoc, stringToDoc } from "./fields/richtext-schema";
import { isMediaKey } from "./media-key";
import { revalidateContent } from "./cache-invalidate";
import { indexContentEntry, removeContentIndex } from "@/lib/search";

// core-v2 §2.4:default ContentProvider("core")over the `contents` table。
//
// 儲存模型:JSON document(免 runtime DDL)。data 欄位為 JSON 字串;filter/sort 走
// SQLite json_extract(data,'$.field')。stored data 內的未知 key 一律保留、不動
// (schema 演變 = manifest 更新;§2.4 明確要求保留 unknown key)。
//
// 日期表示法決策(spec 留白 —— 「ISO string or epoch number, pick one, document it」):
//   **date 欄位一律以 epoch 毫秒 number 儲存與驗證。** 理由:與核心其他 timestamp
//   (createdAt/updatedAt、posts.createdAt)一致,且 json_extract 排序對 number 為
//   數值序、對 ISO 字串為字典序——number 較不易誤排。表單層以 <input type="date"> 提供
//   yyyy-mm-dd,送出前轉為 epoch(見 FormView)。為相容性,validator 亦接受可解析為
//   有限數字的 ISO/日期字串並正規化為 epoch。

const PER_PAGE_CAP = 100;
const SLUG_UNIQUE_MAX = 50; // 唯一化嘗試上限(禁止無界迴圈)。

// Phase E §3: DoS caps. repeater/blocks arrays were previously unbounded
// whenever a manifest omitted `max` (and a manifest-declared `max` was
// honored with no upper ceiling). DEFAULT_ARRAY_MAX applies when `max` is
// absent; ARRAY_MAX_CEILING bounds it even when a manifest declares an
// absurd value (e.g. max: 1e9) — see effectiveArrayMax().
const DEFAULT_ARRAY_MAX = 200;
const ARRAY_MAX_CEILING = 1000;

// json field: reject values that are too large or nest too deep to bound
// worst-case parse/serialize/storage cost of a single field.
const JSON_MAX_CHARS = 100_000;
const JSON_MAX_DEPTH = 20;

/** repeater/blocks effective cap: explicit `max` honored but never above the
 * hard ceiling; absent `max` falls back to the default. */
function effectiveArrayMax(max: number | undefined): number {
  return Math.min(max ?? DEFAULT_ARRAY_MAX, ARRAY_MAX_CEILING);
}

/** Recursion depth of a JSON value (arrays/objects only; scalars = 0). Used to
 * reject pathologically nested `json` field values before they're stored. */
function jsonDepth(value: unknown, depth = 0): number {
  if (depth > JSON_MAX_DEPTH) return depth; // early out; caller only checks > cap
  if (Array.isArray(value)) {
    let max = depth;
    for (const el of value) max = Math.max(max, jsonDepth(el, depth + 1));
    return max;
  }
  if (value !== null && typeof value === "object") {
    let max = depth;
    for (const v of Object.values(value as Record<string, unknown>))
      max = Math.max(max, jsonDepth(v, depth + 1));
    return max;
  }
  return depth;
}

/** filter 值若為 { contains: string } 形狀,回傳該字串;否則 null(走等值)。 */
function isContainsOp(value: unknown): string | null {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "contains" in value &&
    typeof (value as { contains: unknown }).contains === "string"
  ) {
    return (value as { contains: string }).contains;
  }
  return null;
}

/** 跳脫 LIKE 的 % _ \ 特殊字元(搭配 ESCAPE '\')。 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---- 每欄位 validator:回傳正規化後的值,或丟出可讀錯誤 ----

function fail(key: string, msg: string): never {
  throw new ContentValidationError(`field "${key}": ${msg}`, { [key]: msg });
}

/**
 * entry data 驗證失敗;呼叫端(CRUD route)轉為 400。
 *
 * `fields`(field key → message)讓呼叫端能把錯誤對應回表單上的個別欄位,而不只是
 * 顯示一句 generic 訊息。單一欄位失敗即 throw(見 validateData),故目前每個
 * instance 最多帶一組 key/message;仍用 Record 而非單一 pair,方便未來若改成
 * 蒐集多筆錯誤時不必動呼叫端的形狀。`message` 維持不變,供未攜帶 fields 的既有
 * throw 站台(如 update() 的 not-found)相容。
 */
export class ContentValidationError extends Error {
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = "ContentValidationError";
    this.fields = { ...fields };
  }
}

function toEpoch(key: string, v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return fail(key, "expected a date (epoch ms number or ISO string)");
}

/**
 * Tier 2 v1.2:把一組 field defs 對一個 data 物件做「必填檢查 + 逐欄位型別驗證」,
 * 回傳正規化後的新物件(不可變)。這是 top-level validateData 與 nested group/repeater/
 * blocks 共用的核心。`pathPrefix` 用來組合巢狀錯誤路徑(例如 `key[2].subkey`)。
 *
 * 與 validateData 的差異:validateData 額外保留「未在 def 宣告的 unknown key」(§2.4);
 * nested 情境「不」保留 unknown key（結構欄位的形狀由 def 完全決定，避免藏髒資料）。
 */
export function validateFieldSet(
  fields: readonly ContentFieldDef[],
  data: Record<string, unknown>,
  pathPrefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const path = pathPrefix ? `${pathPrefix}.${field.key}` : field.key;
    const present = Object.prototype.hasOwnProperty.call(data, field.key);
    const value = data[field.key];
    const emptyString = typeof value === "string" && value.trim().length === 0;
    if (!present || value === undefined || value === null || emptyString) {
      if (field.required) fail(path, "required");
      continue; // 空值:略過(稀疏 document)。
    }
    out[field.key] = validateField(field, value, path);
  }
  return out;
}

/**
 * validateField:單一欄位驗證。`path` 為此欄位在整份 data 的路徑（供巢狀錯誤定位，
 * 如 `items[2].title`）；預設等於 field.key（top-level）。leaf 型別回傳正規化純量/
 * 陣列;結構型別(group/repeater/blocks)遞迴驗證。所有回傳皆為不可變新值。
 */
function validateField(
  field: ContentFieldDef,
  raw: unknown,
  path: string = field.key,
): unknown {
  const { type } = field;
  // key 已被 path 取代作為錯誤定位；下方 leaf 分支沿用 path 當「key」傳給 fail。
  const key = path;
  switch (type) {
    case "text":
    case "slug":
      if (typeof raw !== "string") return fail(key, "expected string");
      return raw;
    case "richtext": {
      // C.5b: richtext stores a Tiptap JSON document object
      // ({ type: "doc", content: [...] }). Back-compat: a legacy plain STRING
      // is accepted and upgraded to a single-paragraph doc on write, so old
      // string entries validate + normalise without a separate migration. Any
      // other type is rejected.
      //
      // Phase E §6: defense-in-depth. isTiptapDoc only checked the root
      // `type === "doc"` shape; a doc could carry unknown node/mark types or
      // be pathologically large and still pass. isValidRichtextDoc walks the
      // whole tree against the SAME allowlist richtext-render.tsx renders
      // (see richtext-schema.ts for the shared const), plus depth/size caps,
      // so an unrenderable/oversized doc is rejected at write time instead of
      // silently dropped at render time.
      if (typeof raw === "string") return stringToDoc(raw);
      if (!isTiptapDoc(raw)) return fail(key, "expected Tiptap JSON document or string");
      if (!isValidRichtextDoc(raw)) return fail(key, "invalid richtext document");
      return raw;
    }
    case "media":
      // v1:media 儲存為 storage key 字串。
      // Phase E §2: validate the key SHAPE at write time (mirrors the render-time
      // allowlist guard in DetailView/structural-render) — not just "is a string".
      if (typeof raw !== "string") return fail(key, "expected media key string");
      if (!isMediaKey(raw)) return fail(key, "invalid media key");
      return raw;
    case "number":
      if (typeof raw !== "number" || !Number.isFinite(raw))
        return fail(key, "expected finite number");
      return raw;
    case "boolean":
      if (typeof raw !== "boolean") return fail(key, "expected boolean");
      return raw;
    case "date":
      return toEpoch(key, raw);
    case "select": {
      if (typeof raw !== "string") return fail(key, "expected string option");
      const opts = field.options ?? [];
      if (!opts.includes(raw)) return fail(key, `not one of [${opts.join(", ")}]`);
      return raw;
    }
    case "json": {
      // Phase E §3: bound worst-case size/nesting before storing arbitrary
      // JSON. 結構不限,但需通過大小 + 深度上限(避免超大/超深文件拖垮
      // 序列化、儲存或後續 render)。
      let serialized: string;
      try {
        serialized = JSON.stringify(raw);
      } catch {
        return fail(key, "json value is not serializable");
      }
      if (serialized.length > JSON_MAX_CHARS)
        return fail(key, "json value too large/deep");
      if (jsonDepth(raw) > JSON_MAX_DEPTH)
        return fail(key, "json value too large/deep");
      return raw;
    }
    case "relation": {
      // 08 §1:單一目標 entry id 字串。v1 CAVEAT:僅驗「形狀」(非空字串),
      // 不驗目標 entry 是否存在或屬正確 type(避免 create/update 熱路徑每次多一次
      // DB 查詢;referential integrity 為後續議題,見 report author-gap note)。
      if (typeof raw !== "string" || raw.length === 0)
        return fail(key, "expected a non-empty entry id");
      return raw;
    }
    case "relations": {
      // 08 §1:有序 entry id 字串陣列。同樣僅驗形狀(每個元素為非空字串),
      // 不驗存在性。回傳不可變複本(切勿回傳呼叫端傳入的同一陣列參考)。
      if (!Array.isArray(raw)) return fail(key, "expected an array of entry ids");
      const out: string[] = [];
      for (const el of raw) {
        if (typeof el !== "string" || el.length === 0)
          return fail(key, "expected an array of non-empty entry ids");
        out.push(el);
      }
      return out;
    }
    case "group": {
      // Tier 2 v1.2:nested fieldset。value = { …subfield values }。逐子欄位驗證
      // (含各自的 required 檢查)。非物件(或陣列)即形狀錯誤。回傳不可變新物件。
      if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return fail(key, "expected an object of subfield values");
      const sub = field.fields ?? [];
      return validateFieldSet(sub, raw as Record<string, unknown>, key);
    }
    case "repeater": {
      // Tier 2 v1.2:有序 group 陣列。value = [{ … }, …]。每個元素驗為一個 group
      // (同一組子欄位 defs);enforce max。回傳不可變新陣列,保留作者順序。
      if (!Array.isArray(raw))
        return fail(key, "expected an array of row objects");
      // Phase E §3: never unbounded — absent `max` falls back to
      // DEFAULT_ARRAY_MAX, and an explicit `max` is still capped at
      // ARRAY_MAX_CEILING so a manifest can't declare e.g. max: 1e9.
      const max = effectiveArrayMax(field.max);
      if (raw.length > max) return fail(key, `too many items (max ${max})`);
      const sub = field.fields ?? [];
      const rows: Record<string, unknown>[] = [];
      raw.forEach((el, i) => {
        const rowPath = `${key}[${i}]`;
        if (el === null || typeof el !== "object" || Array.isArray(el))
          fail(rowPath, "expected a row object");
        rows.push(
          validateFieldSet(sub, el as Record<string, unknown>, rowPath),
        );
      });
      return rows;
    }
    case "blocks": {
      // Tier 2 v1.2:有序具名 block 陣列。value = [{ block: "<name>", …fields }, …]。
      // 每個元素須有合法 `block`(∈ 宣告的 block names),其餘 key 依該 block 的
      // leaf defs 驗證。enforce max。回傳不可變新陣列,保留 block 標記與作者順序。
      if (!Array.isArray(raw))
        return fail(key, "expected an array of block objects");
      // Phase E §3: same unbounded-array guard as repeater above.
      const max = effectiveArrayMax(field.max);
      if (raw.length > max) return fail(key, `too many blocks (max ${max})`);
      const defs = field.blocks ?? [];
      const byName = new Map(defs.map((b) => [b.name, b]));
      const blocks: Record<string, unknown>[] = [];
      raw.forEach((el, i) => {
        const blockPath = `${key}[${i}]`;
        if (el === null || typeof el !== "object" || Array.isArray(el))
          fail(blockPath, "expected a block object");
        const obj = el as Record<string, unknown>;
        const name = obj["block"];
        if (typeof name !== "string" || !byName.has(name))
          fail(
            `${blockPath}.block`,
            `unknown block (expected one of [${defs.map((b) => b.name).join(", ")}])`,
          );
        const blockDef = byName.get(name as string);
        const validated = validateFieldSet(
          blockDef?.fields ?? [],
          obj,
          blockPath,
        );
        // 保留 block 標記在首位,再接驗證後的欄位。
        blocks.push({ block: name, ...validated });
      });
      return blocks;
    }
    default:
      return fail(key, `unknown field type`);
  }
}

/**
 * 依 type def 驗證整份 data:必填檢查 + 逐欄位型別。未在 def 中宣告的 key 予以保留
 * (§2.4:unknown key 不動),但不做型別檢查。回傳正規化後的新物件(不可變)。
 */
function validateData(
  def: ContentTypeDef,
  data: Record<string, unknown>,
): Record<string, unknown> {
  // 已宣告欄位:必填 + 逐欄位型別(含結構欄位遞迴,見 validateFieldSet/validateField)。
  const out = validateFieldSet(def.fields, data, "");
  // 保留未知 key(§2.4:top-level unknown key 不動;nested 結構欄位則由 def 決定形狀)。
  const known = new Set(def.fields.map((f) => f.key));
  for (const [k, v] of Object.entries(data)) {
    if (!known.has(k)) out[k] = v;
  }
  return out;
}

// ---- publishAt(排程發佈時戳;ROW 欄位,非 JSON data)----
//
// publishAt 與 `status` 一樣是「row 層」欄位,從 API body 流入(見 jobs.ts publish-due)。
// 語意:
//   - 缺 key(hasOwnProperty=false)→ undefined = 不變更(update 時保留既有 column)。
//   - null → 明確清除排程(NULL)。
//   - 有限正整數(epoch ms)→ 設定排程時戳。
// 其他值(非整數、<=0、非 number/非 null)→ ContentValidationError(呼叫端轉 400)。

function extractPublishAt(
  data: Record<string, unknown>,
): number | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, "publishAt")) return undefined;
  const v = data["publishAt"];
  if (v === null) return null;
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  fail("publishAt", "invalid_publish_at");
}

/** 回傳去掉 publishAt 的淺複本(不可變):避免 row 欄位漏進 JSON data。 */
function withoutPublishAt(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(obj, "publishAt")) return obj;
  const { publishAt: _publishAt, ...rest } = obj;
  void _publishAt;
  return rest;
}

/**
 * row 層 publishAt 讀取(admin 編輯表單載入既有排程用)。ContentEntry 刻意不帶
 * row 排程欄位(capabilities.ts 的 provider 介面不動),故這裡提供一個窄的
 * server-side helper。找不到列 → null(視同未排程)。
 */
export async function getContentPublishAt(id: string): Promise<number | null> {
  const rows = await db()
    .select({ publishAt: contents.publishAt })
    .from(contents)
    .where(eq(contents.id, id))
    .limit(1);
  return rows[0]?.publishAt ?? null;
}

// ---- slug ----

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---- row <-> entry ----

interface ContentRow {
  id: string;
  type: string;
  slug: string | null;
  status: string;
  data: string;
  createdAt: number;
  updatedAt: number;
}

function rowToEntry(row: ContentRow): ContentEntry {
  let parsed: Record<string, unknown> = {};
  try {
    const j = JSON.parse(row.data) as unknown;
    if (j && typeof j === "object") parsed = j as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    status: row.status === "published" ? "published" : "draft",
    data: parsed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---- provider 實作 ----

export class CoreContentProvider implements ContentProvider {
  // type def 快取:僅供 validation 用(ensureType 無 DDL 副作用)。
  private readonly typeDefs = new Map<string, ContentTypeDef>();

  constructor(private readonly hooks: HookBus) {}

  private conn() {
    return db();
  }

  // FTS5 全文索引維護(best-effort secondary index)。與 revalidateContent 同哲學:
  // 索引失敗(如 migration 尚未套用、content_fts 不存在)絕不連累主要內容寫入 ——
  // 索引只是次級結構,失去一次同步可由 reindexAll/惰性 backfill 補回。故此處吞掉
  // 例外(不 throw),但主寫入的成功與否完全由上游的 insert/update/delete 決定。
  private async index(entry: ContentEntry): Promise<void> {
    try {
      await indexContentEntry(entry.id, entry.type, entry.data);
    } catch {
      // 見上方註解:FTS 為 best-effort,不阻斷寫入。
    }
  }

  private async unindex(id: string): Promise<void> {
    try {
      await removeContentIndex(id);
    } catch {
      // 見上方註解:FTS 為 best-effort,不阻斷刪除。
    }
  }

  private defOf(type: string): ContentTypeDef | undefined {
    return this.typeDefs.get(type);
  }

  async ensureType(def: ContentTypeDef): Promise<void> {
    // §2.4:無 runtime DDL。僅快取 def 供 create/update 驗證。不可變存入。
    this.typeDefs.set(def.type, {
      ...def,
      fields: def.fields.map((f) => ({ ...f })),
    });
  }

  /** slug 於同 type 內唯一:base 撞了試 base-2、base-3…;上限後改 nanoid 後綴。 */
  private async uniqueSlug(
    type: string,
    base: string,
    excludeId?: string,
  ): Promise<string> {
    const safeBase = base.length > 0 ? base : type.split(".").pop() ?? "item";
    if (!(await this.slugTaken(type, safeBase, excludeId))) return safeBase;
    for (let n = 2; n <= SLUG_UNIQUE_MAX; n++) {
      const candidate = `${safeBase}-${n}`;
      if (!(await this.slugTaken(type, candidate, excludeId))) return candidate;
    }
    return `${safeBase}-${nanoid(6)}`;
  }

  private async slugTaken(
    type: string,
    slug: string,
    excludeId?: string,
  ): Promise<boolean> {
    const rows = await this.conn()
      .select({ id: contents.id })
      .from(contents)
      .where(and(eq(contents.type, type), eq(contents.slug, slug)))
      .limit(2);
    return rows.some((r) => r.id !== excludeId);
  }

  private deriveSlug(
    def: ContentTypeDef | undefined,
    data: Record<string, unknown>,
  ): string | null {
    // 明確 slug 欄位優先,其次 slugField 指定的來源欄位。
    const explicit = data["slug"];
    if (typeof explicit === "string" && explicit.length > 0)
      return slugify(explicit);
    const src = def?.slugField;
    if (src) {
      const v = data[src];
      if (typeof v === "string" && v.length > 0) return slugify(v);
    }
    return null;
  }

  async create(
    type: string,
    data: Record<string, unknown>,
  ): Promise<ContentEntry> {
    const def = this.defOf(type);
    // Phase E §11: no silent unvalidated writes. The CRUD path (dx/crud.ts)
    // always calls ensureType() before create/update, so `def` is missing only
    // if a caller bypasses that contract — fail loud instead of storing
    // unvalidated data.
    if (!def) {
      throw new ContentValidationError(
        `ensureType must be called before create/update for type "${type}"`,
      );
    }
    // publishAt 為 row 欄位(見 extractPublishAt);先驗證再從待存 data 剝除,避免漏進
    // JSON。create 時 undefined(未帶)= 未排程 = NULL。
    const publishAtRaw = extractPublishAt(data);
    const validated = validateData(def, withoutPublishAt(data));
    const now = Date.now();
    const id = nanoid();

    const rawSlug = this.deriveSlug(def, data);
    const slug = rawSlug ? await this.uniqueSlug(type, rawSlug) : null;
    const status = data["status"] === "published" ? "published" : "draft";

    const row = {
      id,
      type,
      slug,
      status,
      publishAt: publishAtRaw ?? null,
      data: JSON.stringify(validated),
      createdAt: now,
      updatedAt: now,
    };
    await this.conn().insert(contents).values(row);

    const entry = rowToEntry(row);
    // FTS 全文索引(best-effort,見 index()):draft/published 皆索引。
    await this.index(entry);
    await this.hooks.doAction("content:created", {
      type,
      id,
      data: entry.data,
    });
    // public content cache 精準失效(guard 於 revalidateContent 內,失敗不影響寫入)。
    revalidateContent(type);
    return entry;
  }

  async get(type: string, id: string): Promise<ContentEntry | null> {
    const rows = await this.conn()
      .select()
      .from(contents)
      .where(and(eq(contents.type, type), eq(contents.id, id)))
      .limit(1);
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async getBySlug(type: string, slug: string): Promise<ContentEntry | null> {
    const rows = await this.conn()
      .select()
      .from(contents)
      .where(and(eq(contents.type, type), eq(contents.slug, slug)))
      .limit(1);
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async update(
    type: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<ContentEntry> {
    const existing = await this.get(type, id);
    if (!existing) {
      throw new ContentValidationError(`entry "${id}" not found in "${type}"`);
    }
    const def = this.defOf(type);
    // Phase E §11: same fail-loud contract as create() above.
    if (!def) {
      throw new ContentValidationError(
        `ensureType must be called before create/update for type "${type}"`,
      );
    }
    // publishAt 為 row 欄位:僅在本次 body 明確帶 key 時變更(undefined = 保留既有
    // column)。先驗證,再從 merged 剝除避免漏進 JSON data。
    const publishAtRaw = extractPublishAt(data);
    // merge:保留既有 data,套用送入的欄位(§2.4 unknown key 保留)。
    const merged = withoutPublishAt({ ...existing.data, ...data });
    const validated = validateData(def, merged);
    const now = Date.now();

    const rawSlug = this.deriveSlug(def, merged);
    const slug = rawSlug
      ? await this.uniqueSlug(type, rawSlug, id)
      : existing.slug;
    const status =
      data["status"] === "published"
        ? "published"
        : data["status"] === "draft"
          ? "draft"
          : existing.status;

    const setValues: {
      slug: string | null;
      status: string;
      data: string;
      updatedAt: number;
      publishAt?: number | null;
    } = {
      slug,
      status,
      data: JSON.stringify(validated),
      updatedAt: now,
    };
    // 未帶 publishAt key → 不動 column(保留既有排程 / NULL)。
    if (publishAtRaw !== undefined) setValues.publishAt = publishAtRaw;

    await this.conn()
      .update(contents)
      .set(setValues)
      .where(and(eq(contents.type, type), eq(contents.id, id)));

    const entry: ContentEntry = {
      ...existing,
      slug,
      status,
      data: validated,
      updatedAt: now,
    };
    // FTS 全文索引 re-index(best-effort,見 index()):以新 data 覆寫該行。
    await this.index(entry);
    await this.hooks.doAction("content:updated", {
      type,
      id,
      data: entry.data,
    });
    // public content cache 精準失效(guard 於 revalidateContent 內,失敗不影響寫入)。
    revalidateContent(type);
    return entry;
  }

  async delete(type: string, id: string): Promise<void> {
    const existing = await this.get(type, id);
    await this.conn()
      .delete(contents)
      .where(and(eq(contents.type, type), eq(contents.id, id)));
    // FTS 全文索引移除(best-effort,見 unindex())。
    await this.unindex(id);
    await this.hooks.doAction("content:deleted", {
      type,
      id,
      data: existing?.data ?? {},
    });
    // public content cache 精準失效(guard 於 revalidateContent 內,失敗不影響刪除)。
    revalidateContent(type);
  }

  async query(
    type: string,
    q: ContentQuery,
  ): Promise<{ items: ContentEntry[]; total: number }> {
    const conds: SQL[] = [eq(contents.type, type)];

    // filter:status/slug 走欄位,其餘走 json_extract。等值為主;文字欄位可用
    // { contains: "…" } 走 LIKE(collection view 的 text search)。值一律由 drizzle
    // 參數化綁定,無字串拼接(防注入);LIKE 的 % _ 特殊字元先跳脫。
    for (const [key, value] of Object.entries(q.filter ?? {})) {
      if (value === undefined || value === null) continue;
      const contains = isContainsOp(value);
      if (contains !== null) {
        if (contains.length === 0) continue; // 空搜尋字串:視為無 filter。
        const pattern = `%${escapeLike(contains)}%`;
        if (key === "slug") {
          conds.push(sql`${contents.slug} LIKE ${pattern} ESCAPE '\\'`);
        } else {
          conds.push(
            sql`json_extract(${contents.data}, ${"$." + key}) LIKE ${pattern} ESCAPE '\\'`,
          );
        }
        continue;
      }
      if (key === "status") {
        conds.push(eq(contents.status, String(value)));
      } else if (key === "slug") {
        conds.push(eq(contents.slug, String(value)));
      } else {
        conds.push(sql`json_extract(${contents.data}, ${"$." + key}) = ${value}`);
      }
    }
    const where = conds.length === 1 ? conds[0] : and(...conds);

    const perPage = Math.min(
      Math.max(1, Math.floor(q.perPage ?? 20)),
      PER_PAGE_CAP,
    );
    const page = Math.max(1, Math.floor(q.page ?? 1));
    const offset = (page - 1) * perPage;

    // sort:created/updated 走欄位,其餘走 json_extract。
    const dir = q.sort?.dir === "asc" ? asc : desc;
    const sortField = q.sort?.field;
    let orderExpr: SQL;
    if (!sortField || sortField === "updatedAt" || sortField === "updated") {
      orderExpr = dir(contents.updatedAt);
    } else if (sortField === "createdAt" || sortField === "created") {
      orderExpr = dir(contents.createdAt);
    } else {
      orderExpr = dir(sql`json_extract(${contents.data}, ${"$." + sortField})`);
    }

    const rows = await this.conn()
      .select()
      .from(contents)
      .where(where)
      .orderBy(orderExpr)
      .limit(perPage)
      .offset(offset);

    const countRows = await this.conn()
      .select({ n: sql<number>`count(*)` })
      .from(contents)
      .where(where);
    const total = countRows[0]?.n ?? 0;

    return { items: rows.map(rowToEntry), total };
  }
}
