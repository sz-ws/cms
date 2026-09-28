import { z } from "zod";
import { resolveLocalizedString, type LocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n";
import type { ProviderRegistry } from "../providers";
import type { OrderAmounts, OrderLine } from "./types";

// commerce-kit 1.63.0:結帳頁的額外欄位(capability "commerce:checkout-fields")。
//
// 插件以 provides 註冊一個 CheckoutFieldProvider,provider id 就是它的命名空間(通常是 extension id)。
// 結帳頁把每個欄位畫出來(hidden 的不畫,值只從瀏覽器記下的 checkout-prefill 帶入),送出時放在
// body.fields["<providerId>.<key>"];伺服器用 validateCheckoutFields 檢查,結果存進訂單的 meta
// (JSON,key 同上)。
//
//   - 要不要出現由 provider 當下決定(fields() 讀自家設定),所以是函式不是 manifest 欄位。
//   - 檢查失敗回 422 { error: "field_invalid", field, code, message },message 是客人的語言。
//   - 沒有「提交時」的 hook:要和訂單同一個 batch 寫的東西(例如依訂單金額記的帳)屬於接手訂單的插件,它讀 meta。
//   - 一個 provider 出錯(fields() 丟例外)只記一行、當作沒有欄位,不擋結帳。

export const CHECKOUT_FIELDS_CAPABILITY = "commerce:checkout-fields";
/** 一次結帳最多幾個欄位(body.fields 超過就 400)。 */
export const MAX_CHECKOUT_FIELDS = 20;
/** 一個欄位的值最多幾個字。 */
export const MAX_FIELD_LENGTH = 500;

const KEY_RE = /^[a-z][a-zA-Z0-9_]{0,30}$/;
const INPUTS = ["text", "textarea", "hidden"] as const;

/** 檢查欄位時看得到的訂單內容(金額已由伺服器算好)。userId:已登入的人,訪客是 null。 */
export interface CheckoutFieldDraft {
  lines: readonly OrderLine[];
  amounts: OrderAmounts;
  email: string;
  userId: string | null;
}

/** ok 可以換掉客人填的值(例如轉大寫);不 ok 的 code 對到 errors 的訊息。 */
export type CheckoutFieldCheck = { ok: true; value?: string } | { ok: false; code: string };

export interface CheckoutField {
  /** 同一個 provider 裡唯一:^[a-z][a-zA-Z0-9_]{0,30}$。 */
  key: string;
  label: LocalizedString;
  /** hidden = 不畫輸入框,值只從瀏覽器記下的(checkout-prefill)帶入。 */
  input: (typeof INPUTS)[number];
  /** 1–500。 */
  maxLength: number;
  required?: boolean;
  validate?(value: string, draft: CheckoutFieldDraft): Promise<CheckoutFieldCheck>;
  /** code → 給客人看的一句話。沒寫的 code 用通用的「…無法使用。」 */
  errors?: Record<string, LocalizedString>;
}

export interface CheckoutFieldProvider {
  fields(): Promise<CheckoutField[]>;
}

/** 宣告的欄位與它在 body.fields / meta 的名字(`<providerId>.<key>`)。 */
export interface DeclaredCheckoutField {
  name: string;
  field: CheckoutField;
}

/** 給結帳頁(client)的欄位:沒有函式,label 已照語言寫好。 */
export interface PublicCheckoutField {
  name: string;
  label: string;
  input: CheckoutField["input"];
  maxLength: number;
  required: boolean;
}

/** body.fields:名字 → 值,最多 MAX_CHECKOUT_FIELDS 個。不認得的名字不理。 */
export const checkoutFieldsBodySchema = z
  .record(z.string().max(80), z.string().max(MAX_FIELD_LENGTH))
  .refine((fields) => Object.keys(fields).length <= MAX_CHECKOUT_FIELDS, "too many fields");

function isField(value: unknown): value is CheckoutField {
  const field = value as Partial<CheckoutField> | null;
  return (
    field !== null &&
    typeof field === "object" &&
    typeof field.key === "string" &&
    KEY_RE.test(field.key) &&
    INPUTS.some((input) => input === field.input) &&
    Number.isInteger(field.maxLength) &&
    (field.maxLength as number) >= 1 &&
    (field.maxLength as number) <= MAX_FIELD_LENGTH &&
    field.label !== undefined
  );
}

function hasFields(impl: unknown): impl is CheckoutFieldProvider {
  return impl !== null && typeof impl === "object" && typeof (impl as CheckoutFieldProvider).fields === "function";
}

/** 已啟用插件宣告的欄位,依 provider 註冊順序。壞掉的欄位與出錯的 provider 略過(記一行)。 */
export async function listCheckoutFields(
  providers: Pick<ProviderRegistry, "list" | "getById">,
): Promise<DeclaredCheckoutField[]> {
  const declared: DeclaredCheckoutField[] = [];
  for (const { id } of providers.list(CHECKOUT_FIELDS_CAPABILITY)) {
    const provider = providers.getById<unknown>(CHECKOUT_FIELDS_CAPABILITY, id);
    if (!hasFields(provider)) continue;
    let fields: unknown;
    try {
      fields = await provider.fields();
    } catch (error) {
      console.error(`[commerce-kit] checkout fields of "${id}"`, error);
      continue;
    }
    for (const field of Array.isArray(fields) ? fields : []) {
      if (!isField(field)) {
        console.error(`[commerce-kit] "${id}" declared an invalid checkout field`, field);
        continue;
      }
      const name = `${id}.${field.key}`;
      if (declared.some((d) => d.name === name)) continue;
      declared.push({ name, field });
    }
  }
  return declared.slice(0, MAX_CHECKOUT_FIELDS);
}

export function publicCheckoutFields(
  declared: readonly DeclaredCheckoutField[],
  locale: Locale = "zh-Hant",
): PublicCheckoutField[] {
  return declared.map(({ name, field }) => ({
    name,
    label: resolveLocalizedString(field.label, locale) ?? field.key,
    input: field.input,
    maxLength: field.maxLength,
    required: field.required === true,
  }));
}

export interface FieldInvalidBody {
  ok: false;
  error: "field_invalid";
  field: string;
  code: string;
  message: string;
}

export type CheckoutFieldsResult =
  | { ok: true; meta: Record<string, string> }
  | { ok: false; body: FieldInvalidBody };

function message(field: CheckoutField, code: string, locale: Locale): string {
  const label = resolveLocalizedString(field.label, locale) ?? field.key;
  const own = field.errors?.[code];
  if (own !== undefined) return resolveLocalizedString(own, locale) ?? code;
  if (code === "required") return `請填${label}。`;
  if (code === "too_long") return `${label}最多 ${field.maxLength} 字。`;
  return `${label}無法使用。`;
}

/**
 * 檢查客人送來的欄位,回傳要存進訂單 meta 的值。core 的結帳在建立付款之前呼叫;接手訂單的插件在自己
 * 的 checkout() 裡呼叫。不認得的名字不理;沒填的非必填欄位不存。
 */
export async function validateCheckoutFields(
  providers: Pick<ProviderRegistry, "list" | "getById">,
  raw: Readonly<Record<string, string>> | undefined,
  draft: CheckoutFieldDraft,
  options: { locale?: Locale; declared?: readonly DeclaredCheckoutField[] } = {},
): Promise<CheckoutFieldsResult> {
  const locale = options.locale ?? "zh-Hant";
  const declared = options.declared ?? (await listCheckoutFields(providers));
  const meta: Record<string, string> = {};
  for (const { name, field } of declared) {
    const value = (raw?.[name] ?? "").trim();
    const fail = (code: string): CheckoutFieldsResult => ({
      ok: false,
      body: { ok: false, error: "field_invalid", field: name, code, message: message(field, code, locale) },
    });
    if (!value) {
      if (field.required) return fail("required");
      continue;
    }
    if (value.length > field.maxLength) return fail("too_long");
    const checked: CheckoutFieldCheck = field.validate ? await field.validate(value, draft) : { ok: true };
    if (!checked.ok) return fail(checked.code);
    meta[name] = checked.value ?? value;
  }
  return { ok: true, meta };
}

/** 422 field_invalid 的回應。 */
export function fieldInvalidResponse(body: FieldInvalidBody): Response {
  return Response.json(body, { status: 422 });
}
