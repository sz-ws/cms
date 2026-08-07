import { z } from "zod";
import type {
  DeclarativeBlockDef,
  DeclarativeField,
  DeclarativeLeafField,
} from "./manifest";

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
      return z.union([z.string(), z.record(z.string(), z.unknown())]);
    case "media":
      // storage key 字串。key 形狀由 provider 的 isMediaKey 把關(不在此複製規則)。
      return z.string();
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
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const base = fieldSchema(field);
    shape[field.key] =
      mode === "create" && field.required ? base : base.optional();
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
