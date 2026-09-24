import { z } from "zod";

// 額外欄位(core.content.extraFields):管理員在設定頁替某一種內容多加幾個欄位,
// 編輯時一起填,值存在那筆內容 data 的 `extra` 底下。
//
// 這支是純模組(只有 zod):設定頁的管理元件、編輯器面板、server 的 CRUD 與對外出口
// 共用同一份規則。讀設定的 server helper 在 ./extra-fields-server.ts —— 放這裡會把
// settings.ts(db / cf)拖進 client bundle。
//
// 為什麼放在 data.extra 而不是跟宣告欄位平鋪:宣告欄位的 key 由插件決定,管理員自訂的
// key 若平鋪,插件哪天加了同名欄位就會互相覆寫;收在一個物件裡,兩邊的命名空間永遠
// 不相交,「不公開的欄位不外流」也只要處理一個 key。

export const EXTRA_FIELDS_SETTING = "core.content.extraFields";

export const EXTRA_FIELD_TYPES = ["boolean", "text", "textarea", "number"] as const;
export type ExtraFieldType = (typeof EXTRA_FIELD_TYPES)[number];

/** 每一種內容最多幾個額外欄位(編輯頁不是表單產生器,多到這個數量該寫成插件了)。 */
export const MAX_EXTRA_FIELDS = 30;
/** 小寫開頭,之後英數與底線;40 字內。網站程式碼用它讀值,所以不收空白與符號。 */
export const EXTRA_FIELD_KEY_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;
export const EXTRA_LABEL_MAX = 60;
const EXTRA_TEXT_MAX = 500;
const EXTRA_TEXTAREA_MAX = 5000;

// 內容類型的完整 key "<extId>.<typeName>",形狀與 manifest 的 relation `to` 相同。
const TYPE_KEY_RE = /^[a-z][a-z0-9-]{1,30}\.[a-z][a-z0-9-]{0,30}$/;

const extraFieldDefSchema = z.strictObject({
  key: z.string().regex(EXTRA_FIELD_KEY_RE),
  label: z.string().trim().min(1).max(EXTRA_LABEL_MAX),
  type: z.enum(EXTRA_FIELD_TYPES),
  public: z.boolean(),
});

export type ExtraFieldDef = z.infer<typeof extraFieldDefSchema>;

const typeDefsSchema = z
  .array(extraFieldDefSchema)
  .max(MAX_EXTRA_FIELDS)
  .superRefine((defs, ctx) => {
    const seen = new Set<string>();
    defs.forEach((def, index) => {
      if (seen.has(def.key)) {
        ctx.addIssue({ code: "custom", path: [index, "key"], message: "duplicate_key" });
      }
      seen.add(def.key);
    });
  });

export const extraFieldsSettingSchema = z.record(
  z.string().regex(TYPE_KEY_RE),
  typeDefsSchema,
);

export type ExtraFieldsSetting = z.infer<typeof extraFieldsSettingSchema>;

/**
 * 存著的設定 → 定義。沒存過是空;壞掉的值(有人直接改了 DB 列)也當空,但要記一筆 ——
 * 當空的後果是「欄位暫時不見、不公開的值也不外流」,比讓每個內容頁 500 好。
 */
export function parseExtraFieldsSetting(value: unknown): ExtraFieldsSetting {
  if (value === undefined || value === null) return {};
  const parsed = extraFieldsSettingSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.error(
    `[extra-fields] ignoring malformed ${EXTRA_FIELDS_SETTING}`,
    parsed.error.issues,
  );
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceOne(def: ExtraFieldDef, raw: unknown): unknown {
  switch (def.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "text": {
      if (typeof raw !== "string") return undefined;
      const text = raw.trim();
      return text ? text.slice(0, EXTRA_TEXT_MAX) : undefined;
    }
    case "textarea":
      // 多行文字保留原本的換行與縮排,只有整段空白才算沒填。
      return typeof raw === "string" && raw.trim()
        ? raw.slice(0, EXTRA_TEXTAREA_MAX)
        : undefined;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  }
}

/**
 * 編輯器送來的 extra → 可以存的 extra。沒定義的 key 丟掉(刪掉的欄位不會在資料裡
 * 越積越多),型別不對或空的值丟掉;順序照定義。回傳新物件,不動輸入。
 */
export function coerceExtraValues(
  defs: readonly ExtraFieldDef[],
  input: unknown,
): Record<string, unknown> {
  if (!isPlainObject(input)) return {};
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const value = coerceOne(def, input[def.key]);
    if (value !== undefined) out[def.key] = value;
  }
  return out;
}

/**
 * CRUD 寫入前整理 body 的 extra:這種內容沒有定義 → 整個拿掉(不存沒人看得到的東西);
 * 有定義 → 換成整理過的值。空物件照樣留著:更新是淺合併,送 `{}` 才清得掉舊值。
 */
export function withCoercedExtra(
  defs: readonly ExtraFieldDef[],
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(body, "extra")) return body;
  const { extra, ...rest } = body;
  if (defs.length === 0) return rest;
  return { ...rest, extra: coerceExtraValues(defs, extra) };
}

/**
 * 給後台以外的人看的 data:extra 只留定義為公開的欄位。沒有定義的 key 一律當不公開 ——
 * 欄位被刪掉之後舊值還躺在資料裡,那些值當初可能是不公開的。一個公開值都不剩就
 * 整個不出現。
 */
export function publicExtras(
  defs: readonly ExtraFieldDef[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(data, "extra")) return data;
  const { extra, ...rest } = data;
  if (!isPlainObject(extra)) return rest;
  const shown: Record<string, unknown> = {};
  for (const def of defs) {
    if (def.public && Object.prototype.hasOwnProperty.call(extra, def.key)) {
      shown[def.key] = extra[def.key];
    }
  }
  return Object.keys(shown).length > 0 ? { ...rest, extra: shown } : rest;
}

/** 已存的 extra → 編輯器的初始值(不是物件就是空的)。 */
export function readExtraValues(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? { ...value } : {};
}
