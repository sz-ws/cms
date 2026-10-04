import { z } from "zod";
import type {
  DeclarativeBlockDef,
  DeclarativeField,
  DeclarativeLeafField,
} from "./manifest";
import { GALLERY_MAX, isMediaKey } from "./media-key";
import { hasUnplaceableImage } from "./fields/richtext-schema";
import type { ExtraFieldDef } from "@/lib/extra-fields";

/**
 * 1.60.0:media 欄位給模型看的一句話(JSON Schema 的 description,也是驗不過時的訊息)。
 * 模型拿到的第一個念頭通常是「圖片 = 網址」,這句話就是為了擋那一步。
 */
export const MEDIA_KEY_HINT =
  "Media key of an uploaded file, such as core/2026/09/abc123.jpg — the `key` returned by core.media.upload " +
  "or listed by core.media.list. Not a URL. An empty string removes the image.";

/**
 * 1.69.1:richtext 欄位給模型看的說明。沒有它,模型只知道「字串或物件」:圖片的 src 用猜的
 * (猜成 media key,存得進去、前台不畫),也不知道 update 是整份取代。
 */
export const RICHTEXT_HINT =
  "Rich text. Plain text works (a blank line starts a new paragraph). For headings, lists, links or images send a " +
  "Tiptap JSON document: { type: \"doc\", content: [nodes] }. Block nodes: paragraph, heading (attrs.level 2 or 3), " +
  "bulletList / orderedList of listItem, blockquote, codeBlock, horizontalRule, image. Inline: text (marks: bold, " +
  "italic, strike, code, link with attrs.href) and hardBreak. An image is its own block between paragraphs: " +
  "{ type: \"image\", attrs: { src: \"/api/files/<media key>\", alt: \"what the picture shows\" } }, with the " +
  "`key` from core.media.list or core.media.upload. The value replaces the whole field: when changing existing " +
  "text, send every block again, not only the new ones. To change only some blocks of a top-level rich text " +
  "field, use the entry's edit_text tool instead.";

/** 圖片的 src 認不出來時退回給模型的訊息。 */
export const RICHTEXT_IMAGE_HINT =
  "An image src must be /api/files/<media key>, with the `key` from core.media.list or core.media.upload. " +
  "Images from other sites can't be used: upload the file first.";

/** 1.66.0:gallery 欄位給模型看的一句話。 */
export const GALLERY_KEYS_HINT =
  "List of media keys (each returned by core.media.upload or listed by core.media.list, not URLs), " +
  "in the order they are shown. An empty list removes all images.";

// docs/spec-admin-agent.md §2:declarative contentTypes 自動生成 tools 時,args
// schema 從 manifest fields 衍生的那一半。
//
// ── 這裡**不是**第二套欄位驗證 ────────────────────────────────────────────────
// 語意驗證的唯一權威仍是 content-provider.ts 的 validateFieldSet/validateField
// (required、select 選項、media key 形狀、richtext 文件合法性、relation 形狀、
// 陣列上限…),而且無論資料從哪條路進來都會跑到。本檔產出的 zod 只做兩件事:
//   1. 把每個欄位的**線上型別**(JSON 層的 string/number/物件形狀)寫成 schema,
//      好讓 Phase B 轉成 JSON Schema 餵給 LLM —— 沒有這個,模型就只能猜欄位名。
//   2. 在進 provider 之前先擋掉形狀明顯不對的 args,給出指得到欄位的錯誤。
// 因此紀律是:**衍生的 schema 永不比 provider 嚴格**(否則會出現「CMS 收得下、
// agent 收不下」的資料),兩處唯一刻意的例外見下面 strict 的說明。
//
// ── 刻意比 provider 嚴的一點:unknown key ───────────────────────────────────
// validateData 對 top-level 未知 key 是「保留不動」(core-v2 §2.4 的 schema 演變
// 需求),巢狀結構欄位則是「丟棄」。兩者對人類作者都合理,但對 LLM 都很糟:幻覺出
// 來的欄位名會安靜地被寫進文件、或安靜地消失,兩種都不會有人發現。所以這裡一律
// .strict() —— 打錯欄位名就當場退回並點名,這正是確認制想要的可見度。

/** leaf 欄位 → 線上型別。刻意寬鬆:凡 provider 收得下的形狀,這裡都收得下。 */
function leafSchema(field: DeclarativeLeafField): z.ZodType {
  switch (field.type) {
    case "text":
    case "slug":
      return z.string();
    case "richtext":
      // provider 收 Tiptap JSON 文件物件,並向後相容純字串(寫入時升級為單段文件)。
      // 比 provider 嚴的第二處(1.69.1):圖片的 src 認不出來就退回。provider 收得下(人在
      // 編輯器貼的外站圖片),但那張圖不會被畫出來;模型不會看前台,只能在這裡得到回饋。
      return z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .refine((v) => typeof v === "string" || !hasUnplaceableImage(v), { message: RICHTEXT_IMAGE_HINT })
        .describe(RICHTEXT_HINT);
    case "media":
      // storage key 字串。1.60.0 起在這裡就用 provider 的**同一支** isMediaKey 驗(不是複製
      // 規則,所以不會比 provider 嚴):模型最常犯的錯是把網址塞進圖片欄位,在 schema 層
      // 退回並說清楚該給什麼,比等 provider 回一句 "invalid media key" 有用。空字串照收 ——
      // provider 把它當成「清掉這張圖」。
      return z
        .string()
        .refine((v) => v.trim().length === 0 || isMediaKey(v), {
          message: MEDIA_KEY_HINT,
        })
        .describe(MEDIA_KEY_HINT);
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "date":
      // provider 存 epoch 毫秒,但也接受可解析的 ISO/日期字串並正規化。
      return z.union([z.number(), z.string()]);
    case "select": {
      // options 由 manifest schema 保證 ≥1;仍防禦性退回 z.string(),因為 z.enum([])
      // 會炸,而「一個沒有選項的 select」不該讓整份 manifest 的 tool 生成失敗。
      const options = field.options ?? [];
      return options.length > 0 ? z.enum(options) : z.string();
    }
    case "json":
      // 結構不限(大小/深度上限由 provider 把關)。
      return z.unknown();
    case "relation":
      return z.string().min(1);
    case "relations":
      return z.array(z.string().min(1));
    case "gallery":
      // 1.66.0:media key 的陣列,順序就是畫面上的順序。每個 key 用同一支 isMediaKey 驗。
      return z
        .array(z.string().refine((v) => isMediaKey(v), { message: MEDIA_KEY_HINT }))
        .max(field.max ?? GALLERY_MAX)
        .describe(GALLERY_KEYS_HINT);
    default:
      // 型別上已窮盡;真的走到這裡代表 manifest 帶了本 core 不認得的欄位型別,
      // 放行讓 provider 去回報,而不是讓整組 tool 生不出來。
      return z.unknown();
  }
}

/**
 * leaf 子欄位陣列 → object shape。required 一律照宣告 —— 巢狀值是「整包替換」語意
 * (provider 的 merge 只在 top-level 淺層合併),所以只要送了這個結構欄位,它的
 * 必填子欄位就必須齊全,create/update 皆然。
 */
function leafShape(
  fields: readonly DeclarativeLeafField[],
): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const base = leafSchema(field);
    shape[field.key] = field.required ? base : base.optional();
  }
  return shape;
}

/** blocks 的單一具名 block:`block` 判別鍵 + 該 block 的 leaf 子欄位。 */
function blockSchema(block: DeclarativeBlockDef): z.ZodType {
  return z
    .object({ block: z.literal(block.name), ...leafShape(block.fields) })
    .strict();
}

/**
 * blocks 欄位的元素 schema。用具名 literal 的 union 而不是鬆散物件,是為了讓
 * Phase B 轉出的 JSON Schema 直接告訴模型「有哪幾種 block、各自要什麼欄位」。
 */
function blocksElementSchema(blocks: readonly DeclarativeBlockDef[]): z.ZodType {
  if (blocks.length === 0) return z.record(z.string(), z.unknown());
  const [first, second, ...rest] = blocks.map(blockSchema);
  if (second === undefined) return first;
  return z.union([first, second, ...rest]);
}

/** 單一 top-level 欄位(leaf 或結構)→ 線上型別。 */
function fieldSchema(field: DeclarativeField): z.ZodType {
  switch (field.type) {
    case "group":
      return z.object(leafShape(field.fields ?? [])).strict();
    case "repeater":
      // max 不在此複製:上限由 provider 統一裁決(未宣告時它另有預設上限),
      // 在兩處各寫一次遲早會漂移。宣告過的上限改寫進 description 給 LLM 看。
      return z.array(z.object(leafShape(field.fields ?? [])).strict());
    case "blocks":
      return z.array(blocksElementSchema(field.blocks ?? []));
    default:
      return leafSchema(field as DeclarativeLeafField);
  }
}

// ── 額外欄位(1.60.0)─────────────────────────────────────────────────────────
// 值住在 data.extra,定義在設定(core.content.extraFields)。寫入前一律再經
// withCoercedExtra / coerceExtraValues 整理(同 crud.ts),這裡只負責讓模型知道有哪些
// key、各是什麼型別,打錯 key 當場退回(同上面 .strict() 的理由)。

/** data 底下放額外欄位的那個 key(lib/extra-fields.ts 的約定)。 */
export const EXTRA_KEY = "extra";

function extraValueSchema(def: ExtraFieldDef): z.ZodType {
  switch (def.type) {
    case "boolean":
      return z.boolean();
    case "number":
      return z.number();
    case "text":
    case "textarea":
      return z.string();
  }
}

/**
 * data.extra 的 schema。update 時每個值也收 null(= 清掉這一格):工具會先把既有的
 * extra 合併進來再整理,所以沒提到的 key 保持原值。
 */
function extraDataSchema(
  defs: readonly ExtraFieldDef[],
  mode: "create" | "update",
): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const def of defs) {
    const base = extraValueSchema(def).describe(def.label);
    shape[def.key] = (mode === "update" ? base.nullable() : base).optional();
  }
  return z.object(shape).strict();
}

/** 額外欄位的人話摘要,接在 describeFields 後面:`extra {spicy: boolean, origin: text}`。 */
export function describeExtraFields(defs: readonly ExtraFieldDef[]): string {
  if (defs.length === 0) return "";
  return `${EXTRA_KEY} {${defs.map((def) => `${def.key}: ${def.type}`).join(", ")}} (fields the site owner added)`;
}

/**
 * content type 的 `data` args schema。
 *
 * mode 的差別只在 top-level required:
 *   - create:provider 對整份 payload 跑必填檢查,故必填欄位在此也必填(讓模型在
 *     送出前就知道少了什麼,而不是等 provider 回一句 field "x": required)。
 *   - update:provider 是「既有 data 淺層合併送入欄位」後才驗證,所以一次只改一個
 *     欄位是合法的;此處全部 optional,否則會逼模型每次都重送整份文件。
 */
export function contentDataSchema(
  fields: readonly DeclarativeField[],
  mode: "create" | "update",
  extraFields: readonly ExtraFieldDef[] = [],
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const base = fieldSchema(field);
    shape[field.key] =
      mode === "create" && field.required ? base : base.optional();
  }
  // 1.60.0:管理員在設定頁加的額外欄位(data.extra,lib/extra-fields.ts)。宣告欄位剛好也
  // 叫 extra 的型別就不加 —— 那個 key 已經是插件的,兩者不能共用一格。
  if (extraFields.length > 0 && !Object.prototype.hasOwnProperty.call(shape, EXTRA_KEY)) {
    shape[EXTRA_KEY] = extraDataSchema(extraFields, mode).optional();
  }
  // shape 是執行期依 manifest 組出來的,zod 對它只能推出 `{}` —— 宣告回傳型別讓
  // 呼叫端拿到可展開的物件型別。實際形狀由上面的迴圈保證,不是憑空放寬。
  return z.object(shape).strict() as unknown as z.ZodType<
    Record<string, unknown>
  >;
}

/** select/relation/結構欄位的補充說明(接在型別後面的括號內容)。 */
function fieldHint(field: DeclarativeField): string {
  switch (field.type) {
    case "select":
      return (field.options ?? []).length > 0
        ? `: ${(field.options ?? []).join("|")}`
        : "";
    case "relation":
    case "relations":
      return field.to ? ` → ${field.to}` : "";
    case "media":
      // 1.60.0:「media key」而不是「media」—— 值是 core.media.upload 回傳的 key,不是網址。
      return " key";
    case "gallery":
      return " keys";
    case "group":
    case "repeater":
      return `{${(field.fields ?? []).map((f) => f.key).join(", ")}}`;
    case "blocks":
      return `{${(field.blocks ?? []).map((b) => b.name).join("|")}}`;
    default:
      return "";
  }
}

/**
 * 欄位清單的人話摘要,放進 tool description。
 *
 * v1 的 tool schema 還沒轉成 JSON Schema(Phase B),所以在那之前,模型認識欄位的
 * 唯一管道就是這段文字;轉換做好之後它仍有價值 —— max、relation 目標這類「schema
 * 表達得出來但表達得很囉嗦」的約束,寫成一行字比塞進 JSON Schema 有效。
 */
export function describeFields(fields: readonly DeclarativeField[]): string {
  return fields
    .map((field) => {
      const parts = [field.type + fieldHint(field)];
      if (field.required) parts.push("required");
      if (field.max !== undefined) parts.push(`max ${field.max}`);
      return `${field.key} (${parts.join(", ")})`;
    })
    .join("; ");
}
