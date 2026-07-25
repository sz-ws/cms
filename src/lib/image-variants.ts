// 圖片變體(縮放 / 格式轉換)的 URL 契約。純函式,零 I/O、零 binding ——
// 所以 render path(server component、client component 都有)與 /api/files 路由
// 可以共用同一份規則,測試也不必起 workerd。
//
// 設計取捨(為什麼是「serve 時轉」而不是「upload 時產變體」):
//   1. upload 時產變體要為每張圖多寫 N 份到 R2 —— 儲存費用乘以 N,而且對「已經
//      上傳的檔案」無效(既有 bucket 補不回來)。
//   2. 變體寬度是設計決策,會隨版型改。烤進 R2 就固定了,改版型等於要重跑回填。
//   3. serve 時轉是 lazy 的:沒人看的圖不花錢。加上 immutable Cache-Control,
//      同一個 variant URL 在邊緣只會真的轉一次。
// 代價是依賴 transform 服務;那條依賴的降級路徑寫在 /api/files 路由裡
// (轉不動就原樣送原圖,絕不 404)。

/**
 * 允許的變體寬度(srcset 的刻度)。
 *
 * 這是**封閉清單**,不是建議值:`?w=` 一律被 snap 進這幾格。理由是 cache key ——
 * 若放任任意寬度,一個 `?w=1..2000` 的迴圈就能逼出兩千次獨立轉換(轉換有計費、
 * 邊緣快取也被灌爆)。五格覆蓋 320→1920 的實際版型需求已足夠。
 */
export const VARIANT_WIDTHS = [320, 640, 960, 1280, 1920] as const;

/** 輸出格式。`webp` 為預設:alpha、動畫都支援,瀏覽器覆蓋率 ~97%,且不必 Vary: Accept。 */
export const VARIANT_FORMATS = ["webp", "avif", "jpeg", "png"] as const;
export type VariantFormat = (typeof VARIANT_FORMATS)[number];

/** `?w=` 只給寬度時採用的輸出格式。見上方 VARIANT_FORMATS 的說明。 */
export const DEFAULT_VARIANT_FORMAT: VariantFormat = "webp";

/**
 * VariantFormat → 輸出 Content-Type(ImagesBinding 的 output() 收完整 MIME)。
 * 值刻意標成字面值型別,讓它直接對得上 ImageOutputOptions["format"],不必 cast。
 */
export const FORMAT_CONTENT_TYPE = {
  webp: "image/webp",
  avif: "image/avif",
  jpeg: "image/jpeg",
  png: "image/png",
} as const satisfies Record<VariantFormat, string>;

/**
 * 可轉換的來源型別。
 *
 * 刻意排除:
 *   - `image/gif` —— 動圖轉靜態是資料破壞,而轉動態 webp 的成本/收益不成比例。
 *   - `image/svg+xml` —— 向量本來就不需要縮放,且它連 /api/files 的白名單都不在。
 */
const TRANSFORMABLE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

/** 副檔名版本的同一份規則(list 回來沒有 contentType 時的後備)。 */
const TRANSFORMABLE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "avif"]);

/** contentType(可帶 charset 參數)是否可轉換。 */
export function isTransformableContentType(contentType: string): boolean {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  return TRANSFORMABLE_CONTENT_TYPES.has(ct);
}

/** storage key 的副檔名是否可轉換。 */
export function isTransformableKey(key: string): boolean {
  const dot = key.lastIndexOf(".");
  if (dot < 0) return false;
  return TRANSFORMABLE_EXTS.has(key.slice(dot + 1).toLowerCase());
}

/**
 * 把任意數字 snap 進 VARIANT_WIDTHS:取「第一個 ≥ n 的刻度」,超過最大值就取最大值。
 * n 非有限正數 → undefined(呼叫端當成「不指定寬度」)。
 */
export function snapWidth(n: number): number | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  for (const w of VARIANT_WIDTHS) if (n <= w) return w;
  return VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
}

/** 原檔 URL。key 必須先過 isMediaKey(呼叫端負責),這裡不再驗一次。 */
export function fileUrl(key: string): string {
  return `/api/files/${key}`;
}

export interface VariantRequest {
  width?: number;
  format?: VariantFormat;
}

/**
 * 變體 URL。沒帶任何選項時退回原檔 URL(不留空 query,免得同一張圖出現兩個
 * 等價但不同的 cache key)。
 */
export function variantUrl(key: string, req: VariantRequest = {}): string {
  const params: string[] = [];
  const w = req.width === undefined ? undefined : snapWidth(req.width);
  if (w !== undefined) params.push(`w=${w}`);
  if (req.format) params.push(`f=${req.format}`);
  if (params.length === 0) return fileUrl(key);
  return `${fileUrl(key)}?${params.join("&")}`;
}

/**
 * srcset 字串。回傳 undefined = 這個 key 不該給 srcset(非可轉換型別),
 * 呼叫端就只放 src,行為與現況完全一致。
 *
 * 只挑 ≤ maxWidth 的刻度,再保底補上 maxWidth 那一格:小圖(如 32px 縮圖)
 * 不需要 1920w 的候選,列出來只會讓瀏覽器在高 DPR 下抓過大的檔。
 */
export function buildSrcSet(
  key: string,
  maxWidth: number = VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1],
): string | undefined {
  if (!isTransformableKey(key)) return undefined;
  const cap = snapWidth(maxWidth) ?? VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
  const widths = VARIANT_WIDTHS.filter((w) => w <= cap);
  if (widths.length === 0) return undefined;
  return widths.map((w) => `${variantUrl(key, { width: w })} ${w}w`).join(", ");
}

/**
 * 變體的 ETag。不能沿用原檔的 httpEtag —— 那樣 `?w=320` 與 `?w=1920` 會共用同一個
 * 驗證器,下游快取就會互相污染。加後綴,並維持合法的 quoted-string 形狀。
 */
export function variantEtag(httpEtag: string, req: VariantRequest): string {
  const suffix = `${req.width ?? "orig"}-${req.format ?? "orig"}`;
  const trimmed = httpEtag.endsWith('"') ? httpEtag.slice(0, -1) : httpEtag;
  return `${trimmed}-${suffix}"`;
}

/**
 * 解析 /api/files 的 query。回傳 null = 不做任何轉換(原樣送原檔)。
 *
 * 寬鬆解析、嚴格輸出:看不懂的值一律當成「沒指定」而不是 400 —— 這條路徑是公開的
 * 圖片 serving,壞 query 讓它退回原圖比回錯誤碼有用。
 */
export function parseVariantRequest(
  params: URLSearchParams,
): VariantRequest | null {
  const rawW = params.get("w");
  const rawF = params.get("f");

  const width = rawW === null ? undefined : snapWidth(Number(rawW));
  const format =
    rawF !== null && (VARIANT_FORMATS as readonly string[]).includes(rawF)
      ? (rawF as VariantFormat)
      : undefined;

  if (width === undefined && format === undefined) return null;
  return {
    ...(width === undefined ? {} : { width }),
    format: format ?? DEFAULT_VARIANT_FORMAT,
  };
}
