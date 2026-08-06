import type { StoredFile } from "@/lib/storage";

// core-v2 §2.3:capability 介面(v1)。此檔僅型別 —— ContentProvider 的實作屬 Phase C。

/** 已知 capability;registry 亦接受任意字串(未來 doc-extraction 等免改 core)。 */
export type Capability = "upload" | "content" | "doc-extraction" | (string & {});

// ---- callback receiver(core-v2 §2.5:unified inbound webhook ingress)----
//
// 這是 provider outbound 方法(charge/submit/put)的 **inbound 對應**。實作此介面的
// provider 可透過 POST /api/callback/<capability>/<providerId> 接收外部服務回呼
// (payment 結果、extraction 完成、OAuth redirect)。
//
// 契約(spec §2.5 + §5):
//   1. verifyCallback:對 **原始未解析** 的 rawBody 做簽章/HMAC 驗證,簽章密鑰取自
//      加密 settings(secret:true)。以 constant-time 比較,回 true/false。
//      —— 這是唯一的認證(callback 無 session、無 Origin 檢查:呼叫者是外部服務)。
//   2. handleCallback:處理 **已驗證** 事件(更新 D1、觸發 hook 如 payment:succeeded /
//      extraction:completed 讓其他 extension 反應)。僅在 verify 通過後才會被呼叫。
//
// 為 additive/optional:provider **可以**實作(mixin),不實作者仍為合法 provider。
// ingress route 會檢查兩個方法是否俱在,缺任一即視為「不接收 callback」→ 404。
//
// 1.14.0:handleCallback 可(選擇性)回傳 Response。回傳時 ingress 原樣轉發給呼叫端,
// 取代預設的 `{ok:true}` JSON —— 供「呼叫端是使用者瀏覽器」的回呼使用:payment gateway
// 的 ReturnURL(付款完成後瀏覽器被 form-POST 導回,需要回 HTML 結果頁或 303 redirect)、
// 未來 OAuth redirect 等。回 undefined/void = 既有行為不變(server-to-server webhook
// 維持 `{ok:true}`)。僅在 verify 通過後才會執行,安全契約(先驗後處理)不變。
export interface CallbackReceiver {
  verifyCallback(rawBody: string, headers: Headers): boolean | Promise<boolean>;
  handleCallback(
    rawBody: string,
    headers: Headers,
  ): Promise<void | Response>;
}

/** 型別守衛:某 provider impl 是否實作了完整的 CallbackReceiver(兩個方法俱在)。 */
export function isCallbackReceiver(impl: unknown): impl is CallbackReceiver {
  if (impl === null || typeof impl !== "object") return false;
  const cand = impl as Partial<CallbackReceiver>;
  return (
    typeof cand.verifyCallback === "function" &&
    typeof cand.handleCallback === "function"
  );
}

// ---- payment(1.14.0)----
//
// capability = "payment"。provider 由 code extension 以 `provides` 註冊(如
// extensions/newebpay),core 不內建任何 payment provider —— registry 查無 provider
// 時呼叫端自行處理(payment 是「裝了才有」的能力,與 ai:generate 恆註冊不同)。
//
// createCheckout 回傳 CheckoutSession union,對應三種付款交互模式:
//   - "form-post":gateway 要求瀏覽器對其 URL form-POST 一組欄位(藍新 MPG、綠界)。
//     呼叫端(admin UI / 前台)以 fields 建立 <form> auto-submit。
//   - "redirect":gateway 給一個 URL,瀏覽器直接導過去(Stripe Checkout 型)。
//   - "manual"(1.28.0):沒有 gateway 的人工收款(銀行轉帳/ATM)。回一組展示給
//     付款人的指示(收款帳號、金額、訂單編號…),付款結果由 admin 人工核帳後結算
//     —— 走與 gateway 回呼**同一段**冪等結算 + payment:succeeded hook(見
//     payment-kit/manual.ts),所以消費端(commerce)不需要分辨付款方式。
// 失敗一律 { ok:false, error } —— 與 AiGenerateResult 同精神,設定缺失回
// "not_configured",不 throw。
//
// 付款結果為非同步:gateway server-to-server 回呼 POST /api/callback/payment/<id>
// (provider 同時實作 CallbackReceiver),驗簽通過後由 provider 更新自己的訂單表並
// doAction("payment:succeeded", { providerId, event })。

export interface CheckoutRequest {
  /** 商店訂單編號(provider 端唯一;字元集依 gateway 限制,由 provider 驗證)。 */
  orderNo: string;
  /** 金額(整數,最小貨幣單位;TWD 即元)。 */
  amount: number;
  /** 商品描述(顯示於 gateway 付款頁)。 */
  description: string;
  /** 付款人 email(gateway 通知/收據用;省略時由 provider 決定預設)。 */
  email?: string;
}

/** manual session 的單行付款指示(label → value,原樣展示給付款人)。 */
export interface ManualInstructionLine {
  label: string;
  value: string;
}

export type CheckoutSession =
  | {
      ok: true;
      kind: "form-post";
      /** gateway 端點,瀏覽器對它 POST。 */
      gatewayUrl: string;
      /** form 欄位(name → value),全部 hidden input 即可。 */
      fields: Record<string, string>;
    }
  | { ok: true; kind: "redirect"; url: string }
  | {
      ok: true;
      /** 1.28.0:人工收款(無 gateway)。付款人照 instructions 匯款,admin 核帳結算。 */
      kind: "manual";
      providerId: string;
      /** 付款指示(收款銀行/帳號/金額/訂單編號…),呼叫端逐行展示。 */
      instructions: ManualInstructionLine[];
      /** 附註(如「請於備註填寫訂單編號」)。 */
      note?: string;
    }
  | { ok: false; error: string };

export interface PaymentProvider {
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
}

// ---- upload ----

export interface UploadProvider {
  put(
    scope: string,
    filename: string,
    body: Blob | ReadableStream,
    contentType: string,
  ): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  url(key: string): string; // default:`/api/files/${key}`
}

// ---- content(v1 僅型別;實作為 Phase C)----

export interface ContentEntry {
  id: string; // nanoid
  type: string;
  /**
   * BCP-47 locale tag(migrations/0011,CORE_API 1.20.0)。一列一個 (entry, locale)。
   * **optional 是刻意的**:若設成必填,所有既有的 ContentProvider 實作與手工組出的
   * ContentEntry 都會編不過 —— 那是 provider 介面破壞,依 version.ts 的規則屬 major。
   * core provider 一律填值;第三方 provider 不填就視同站台預設語言。
   */
  locale?: string;
  /**
   * 同一份內容各語言版本的連結鍵(migrations/0011)。group 第一列 = 自己的 id,
   * 其譯本原樣複製此值。用來回答「這頁缺哪些語言的版本」。同 locale,optional。
   */
  translationGroup?: string;
  slug: string | null;
  status: "draft" | "published";
  data: Record<string, unknown>; // 依 field defs 驗證
  createdAt: number;
  updatedAt: number;
}

/** leaf(單值)欄位型別。可作 top-level,也可作 group/repeater/blocks 的 nested 子欄位。 */
export type LeafFieldType =
  | "text"
  | "richtext"
  | "number"
  | "boolean"
  | "date"
  | "media"
  | "select"
  | "slug"
  | "json"
  | "relation"
  | "relations";

/** 結構(compound)欄位型別(Tier 2 v1.2)。只可作 top-level(一層 nesting 上限)。 */
export type StructuralFieldType = "group" | "repeater" | "blocks";

/** blocks 的具名 block:name + leaf 子欄位定義。 */
export interface ContentBlockDef {
  name: string;
  label?: string;
  fields: ContentLeafFieldDef[];
}

/**
 * leaf 欄位定義:top-level 或 nested 皆用此形狀(型別限制為 LeafFieldType,故不含
 * fields/blocks —— 結構欄位不可再嵌結構欄位)。
 */
export interface ContentLeafFieldDef {
  key: string;
  type: LeafFieldType;
  label?: string;
  required?: boolean;
  options?: string[]; // select 用
  to?: string; // 08 §1:relation/relations 的目標 type key "<extId>.<typeName>"
  indexed?: boolean; // §2.4:未來側索引表用,v1 忽略
}

/**
 * content type 欄位定義(core-v2 §3.2 field types v1 + 08 §1 relation/relations
 * + Tier 2 v1.2 的 group/repeater/blocks)。
 * - relation/relations 需帶 `to`(目標 content type key "<extId>.<typeName>")。
 * - group/repeater 帶 `fields`(nested leaf 子欄位);blocks 帶 `blocks`(具名 block 陣列)。
 * - repeater/blocks 可帶 `max`(實例數上限)。
 * manifest.ts 的 zod union 與 JSON Schema 皆已強制上述對稱與一層 nesting 界。
 */
export interface ContentFieldDef {
  key: string;
  type: LeafFieldType | StructuralFieldType;
  label?: string;
  required?: boolean;
  options?: string[]; // select 用
  to?: string; // 08 §1:relation/relations 的目標 type key "<extId>.<typeName>"
  indexed?: boolean; // §2.4:未來側索引表用,v1 忽略
  fields?: ContentLeafFieldDef[]; // Tier 2:group/repeater 的 nested 子欄位
  blocks?: ContentBlockDef[]; // Tier 2:blocks 的具名 block 宣告
  max?: number; // Tier 2:repeater/blocks 的實例數上限
}

export interface ContentTypeDef {
  type: string; // 完整 type key,如 "gallery.item"
  label?: string;
  slugField?: string; // auto-slug 來源欄位
  fields: ContentFieldDef[];
}

/** filter 值:純量走等值;{ contains } 走 LIKE(文字/slug 欄位的 search)。 */
export type ContentFilterValue = string | number | boolean | { contains: string };

export interface ContentQuery {
  filter?: Record<string, ContentFilterValue>;
  sort?: { field: string; dir: "asc" | "desc" };
  page?: number;
  perPage?: number; // 上限 100
}

export interface ContentProvider {
  ensureType(def: ContentTypeDef): Promise<void>;
  create(type: string, data: Record<string, unknown>): Promise<ContentEntry>;
  get(type: string, id: string): Promise<ContentEntry | null>;
  /**
   * slug 查單筆。第三個參數 `locale` 為 optional(CORE_API 1.20.0):省略 = 不限語言
   * (維持舊行為,既有兩參數實作仍可指派 —— 必填會是 major 破壞)。公開路徑應一律帶。
   */
  getBySlug(
    type: string,
    slug: string,
    locale?: string,
  ): Promise<ContentEntry | null>;
  update(
    type: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<ContentEntry>;
  delete(type: string, id: string): Promise<void>;
  query(
    type: string,
    q: ContentQuery,
  ): Promise<{ items: ContentEntry[]; total: number }>;
}
