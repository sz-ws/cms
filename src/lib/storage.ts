import { nanoid } from "nanoid";
import { getStorage } from "./cf";
import { sniffImageSize, SNIFF_BYTES } from "./image-dimensions";
// 注意:loader 以動態 import 載入,避免 storage → loader → registry → posts/api →
// storage 的靜態循環相依(會造成 "Cannot access before initialization")。

// 06 §2:Storage 抽象層。所有檔案操作經此,extension 不直接碰 R2 binding。

export interface StoredFile {
  key: string;
  size: number;
  contentType: string;
  /**
   * Alt text(圖片替代文字)。存在 R2 object 的 customMetadata["alt"],
   * 不另建 D1 資料表:R2 `list()` 帶 include: ["customMetadata"] 就能一次撈回,
   * 不需要第二次查詢,也不需要 runtime DDL / migration。
   * undefined = 未設定(與空字串同義,寫入端會把空字串當成「清除」)。
   */
  alt?: string;
  /**
   * 原生像素寬 / 高。與 alt 同樣住在 R2 customMetadata(欄位名 "w" / "h"),
   * 不另建 D1 表、不需要 migration —— list() 已經 include customMetadata,
   * 所以尺寸是**免費**跟著回來的,沒有第二次查詢。
   *
   * undefined = 這個物件沒有尺寸資訊。三種情況都會這樣:非圖片、嗅不出來的
   * 格式、或是這個功能上線**之前**就已經在 bucket 裡的舊檔。render 端遇到
   * undefined 就不放 width/height 屬性,行為與現況一致(不會壞)。
   */
  width?: number;
  height?: number;
}

/** customMetadata 的欄位名。單一常數,避免各處字面值飄移。 */
const ALT_META_KEY = "alt";
const WIDTH_META_KEY = "w";
const HEIGHT_META_KEY = "h";

/** customMetadata 的字串值 → 正整數;非法一律 undefined。 */
function parseDim(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 從 customMetadata 取出寬高(兩邊都在才算數)。 */
function dimsOf(meta: Record<string, string> | undefined): {
  width?: number;
  height?: number;
} {
  const width = parseDim(meta?.[WIDTH_META_KEY]);
  const height = parseDim(meta?.[HEIGHT_META_KEY]);
  return width !== undefined && height !== undefined ? { width, height } : {};
}

/**
 * 取檔頭前 SNIFF_BYTES 個 byte 來嗅尺寸。
 *
 * ReadableStream 一律回 null:要 peek 就得 tee 或整份讀進來,前者會讓兩端的
 * backpressure 互相卡住,後者等於把串流上傳的意義消掉。上傳路徑
 * (/api/media/upload)傳的是 File(Blob),走得到 slice,所以實務上不會落在
 * 這個分支;真的走串流的呼叫端就沒有尺寸,render 端已經能處理 undefined。
 */
async function sniffDims(
  body: ReadableStream | ArrayBuffer | Blob,
  contentType: string,
): Promise<{ width?: number; height?: number }> {
  if (!contentType.toLowerCase().startsWith("image/")) return {};
  try {
    let head: ArrayBuffer;
    if (body instanceof Blob) {
      head = await body.slice(0, SNIFF_BYTES).arrayBuffer();
    } else if (body instanceof ArrayBuffer) {
      head = body.slice(0, SNIFF_BYTES);
    } else {
      return {};
    }
    const size = sniffImageSize(new Uint8Array(head));
    return size ? { width: size.width, height: size.height } : {};
  } catch {
    // 嗅探絕不可以讓上傳失敗 —— 尺寸是加分項,檔案本身才是重點。
    return {};
  }
}

/**
 * alt 長度上限。R2 對單一 object 的 metadata 總量有限額(數 KB),
 * 且 alt 屬性本來就該是一句話;超過一律截斷而非拒絕,避免上傳失敗。
 */
export const MAX_ALT_LENGTH = 500;

/**
 * alt 正規化:trim + 摺疊所有空白(含換行/控制字元)成單一空格 + 截斷。
 * alt 屬性是單行文字,換行進去只會變成無意義的空白。
 * 回傳空字串代表「沒有 alt」。
 */
export function normalizeAlt(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim().slice(0, MAX_ALT_LENGTH);
}

/** 從原始檔名取小寫副檔名,僅允許 [a-z0-9]{1,8};否則回傳 "bin"。 */
function safeExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "bin";
  const ext = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
}

/** 產生 key:`<scope>/<yyyy>/<mm>/<nanoid>.<ext>`。 */
function makeKey(scope: string, filename: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${scope}/${yyyy}/${mm}/${nanoid()}.${safeExt(filename)}`;
}

export async function putFile(
  scope: string, // "core" 或 extId
  filename: string, // 原始檔名(只取副檔名)
  body: ReadableStream | ArrayBuffer | Blob,
  contentType: string,
  alt?: string, // 選填:一併寫入 customMetadata["alt"](空字串 = 不寫)
): Promise<StoredFile> {
  const key = makeKey(scope, filename);
  const normalized = alt ? normalizeAlt(alt) : "";
  // 尺寸在**寫入時**嗅一次就定案:R2 不會重跑上傳,漏掉就永遠補不回來。
  const dims = await sniffDims(body, contentType);
  const customMetadata: Record<string, string> = {};
  if (normalized) customMetadata[ALT_META_KEY] = normalized;
  if (dims.width !== undefined && dims.height !== undefined) {
    customMetadata[WIDTH_META_KEY] = String(dims.width);
    customMetadata[HEIGHT_META_KEY] = String(dims.height);
  }
  const obj = await getStorage().put(key, body, {
    httpMetadata: { contentType },
    // customMetadata 只在有值時帶,免得每個物件都掛一個空欄位。
    ...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
  });
  const file: StoredFile = {
    key,
    size: obj?.size ?? 0,
    contentType,
    ...(normalized ? { alt: normalized } : {}),
    ...dims,
  };
  // storage:uploaded hook(03 §1:({ key, size, contentType }))。
  // 動態 import 打破循環相依(見檔頭註解)。
  const { getExtRuntime } = await import("@/ext/loader");
  const rt = await getExtRuntime();
  await rt.hooks.doAction("storage:uploaded", file);
  return file;
}

export async function getFile(key: string): Promise<R2ObjectBody | null> {
  return (await getStorage().get(key)) ?? null;
}

/**
 * 只取 metadata(不拉 body)。給 render 端補 width/height 用 —— DetailView 之類
 * 的 server component 手上只有一個 storage key,尺寸得從這裡來。
 * R2 head() 不計輸出流量,單張圖成本約等於一次 metadata 查詢。
 */
export async function headFile(key: string): Promise<StoredFile | null> {
  const obj = await getStorage().head(key);
  if (!obj) return null;
  const alt = obj.customMetadata?.[ALT_META_KEY];
  return {
    key,
    size: obj.size,
    contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
    ...(alt ? { alt } : {}),
    ...dimsOf(obj.customMetadata),
  };
}

export async function deleteFile(key: string): Promise<void> {
  await getStorage().delete(key);
}

export async function listFiles(
  prefix: string,
  cursor?: string,
): Promise<{ files: StoredFile[]; cursor?: string }> {
  // 注意:不帶 include 的話 R2 list 不回傳 contentType;customMetadata 同理
  // ——alt 就住在那裡,所以兩個都要 include(一次 list 全撈回,不必逐檔 head())。
  const result = await getStorage().list({
    prefix,
    cursor,
    limit: 100,
    include: ["httpMetadata", "customMetadata"],
  });
  const files: StoredFile[] = result.objects.map((o) => {
    const alt = o.customMetadata?.[ALT_META_KEY];
    return {
      key: o.key,
      size: o.size,
      contentType: o.httpMetadata?.contentType ?? "application/octet-stream",
      ...(alt ? { alt } : {}),
      ...dimsOf(o.customMetadata),
    };
  });
  return {
    files,
    cursor: result.truncated ? result.cursor : undefined,
  };
}

/** updateFileAlt 的結果。conflict = 期間物件被別人覆蓋,呼叫端該重試。 */
export type UpdateAltResult =
  | { ok: true; file: StoredFile }
  | { ok: false; reason: "not_found" | "conflict" };

/**
 * 更新單一 object 的 alt(customMetadata)。
 *
 * R2 沒有「只改 metadata」的 API:`put()` 會整個覆蓋 object,連 body 一起。
 * 所以這裡必須先 get 出原始 body,再連同(合併過的)metadata put 回去——
 * 直接 put(key, null) 或 put 空 body 會把檔案內容清空,是資料損毀。
 *
 * 兩個保命細節:
 * 1. httpMetadata 與其他 customMetadata 欄位原樣帶回,只動 alt 這一格。
 * 2. `onlyIf: { etagMatches }`:get 與 put 之間若有人重新上傳同一個 key,
 *    put 會被拒絕(回 null)而不是拿舊 body 蓋掉新檔案 → 回 conflict。
 *
 * body 走 arrayBuffer() 而非 stream:上傳端上限 25MB(見 /api/media/upload),
 * 在 Workers 記憶體預算內;streaming 反而要自行處理長度與重試。
 */
export async function updateFileAlt(
  key: string,
  alt: string,
): Promise<UpdateAltResult> {
  const obj = await getStorage().get(key);
  if (!obj) return { ok: false, reason: "not_found" };

  const normalized = normalizeAlt(alt);
  const customMetadata = { ...(obj.customMetadata ?? {}) };
  if (normalized) customMetadata[ALT_META_KEY] = normalized;
  else delete customMetadata[ALT_META_KEY]; // 空字串 = 清除 alt

  const contentType =
    obj.httpMetadata?.contentType ?? "application/octet-stream";
  const body = await obj.arrayBuffer();

  const put = await getStorage().put(key, body, {
    httpMetadata: obj.httpMetadata ?? { contentType },
    customMetadata,
    onlyIf: { etagMatches: obj.etag },
  });
  if (!put) return { ok: false, reason: "conflict" };

  return {
    ok: true,
    file: {
      key,
      size: put.size,
      contentType,
      ...(normalized ? { alt: normalized } : {}),
      // w / h 已經隨 customMetadata 原樣寫回(見上方 spread);回傳的 DTO 也要帶,
      // 否則 admin 端存一次 alt 就會把尺寸從畫面上抹掉。
      ...dimsOf(customMetadata),
    },
  };
}
