import { z } from "zod";
import { listFiles, MAX_ALT_LENGTH, type StoredFile } from "@/lib/storage";
import { MEDIA_UPLOAD_MAX_BYTES, saveMediaUpload } from "@/lib/media-upload";
import {
  REMOTE_IMAGE_URL_MAX,
  base64MaxChars,
  decodeBase64Image,
  fetchRemoteImage,
} from "@/lib/remote-image";
import { getPlainSetting } from "@/lib/settings";
import type { Locale } from "@/lib/i18n/index";
import { defineAgentTool, readStringArg } from "./agent-tools";
import type { AgentTool, AgentToolCtx } from "./agent-tools";
import type { UploadProvider } from "./capabilities";

// 1.60.0:媒體庫的 agent tools —— 後台助理與 AI 連線(MCP)共用同一份 registry,所以兩邊
// 同時拿到。
//
//   core.media.list    read   找已經在媒體庫裡的檔案(key、網址、尺寸、替代文字)。
//   core.media.upload  write  從公開網址或 base64 加一張圖進媒體庫,回傳 key。
//
// ── 為什麼 upload 回傳的重點是 key ───────────────────────────────────────────
// 內容的圖片欄位(declarative 的 media 型別:商品的 image、文章的 cover…)存的是 storage
// key,不是網址(content-provider 以 isMediaKey 驗;render 端才組成 /api/files/<key>)。
// 模型拿到網址很自然會把網址塞進欄位,然後被拒。所以 description 與結果都把 key 放在
// 最前面,生成的 content.*.create/update 的欄位說明也講同一件事(dx/agent-field-schema.ts)。
//
// ── 存檔走哪條路 ─────────────────────────────────────────────────────────────
// lib/media-upload.ts#saveMediaUpload —— 與後台上傳(/api/media/upload)同一支:同一個
// key 規則、同一次尺寸嗅探、同一個 storage:uploaded hook。這裡只多做「把來源變成 byte」
// 與「從 byte 認格式」兩件事(lib/remote-image.ts),不另寫一套上傳。
//
// ── 沒有 display ────────────────────────────────────────────────────────────
// agent-display 目前只有圖表家族(佔比 / 趨勢),沒有縮圖格。list 的結果以文字回給模型,
// write 的結果本來就不畫卡(/execute 不走 display)。

/** 一次 list 最多往下翻幾頁 R2(每頁 100 個物件)。 */
const LIST_MAX_PAGES = 10;
const LIST_DEFAULT_LIMIT = 10;
const LIST_MAX_LIMIT = 50;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)$/i;

function isImage(file: StoredFile): boolean {
  return file.contentType.toLowerCase().startsWith("image/") || IMAGE_EXT_RE.test(file.key);
}

/** core.siteUrl 是有效的 http(s) 網址就回它的 origin,否則 null(網址維持站內相對路徑)。 */
async function siteOrigin(): Promise<string | null> {
  const raw = await getPlainSetting<unknown>("core.siteUrl", "");
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function absoluteUrl(url: string, origin: string | null): string {
  return origin && url.startsWith("/") ? `${origin}${url}` : url;
}

/** 回給模型的一個檔案。key 在最前面:圖片欄位存的是它。 */
interface AgentMediaView {
  key: string;
  url: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
  alt?: string;
}

function toView(file: StoredFile, url: string): AgentMediaView {
  return {
    key: file.key,
    url,
    contentType: file.contentType,
    size: file.size,
    ...(file.width !== undefined && file.height !== undefined
      ? { width: file.width, height: file.height }
      : {}),
    ...(file.alt ? { alt: file.alt } : {}),
  };
}

// ---- list 的游標 ----
// R2 的 cursor 只能停在頁與頁之間,但一頁 100 個、模型一次只要幾個。游標因此是
// `<這一頁從第幾個開始>:<R2 cursor>`(第一頁的 R2 cursor 是空字串)。

interface ListPosition {
  offset: number;
  r2Cursor: string | undefined;
}

function parseListCursor(raw: string | undefined): ListPosition {
  if (!raw) return { offset: 0, r2Cursor: undefined };
  const colon = raw.indexOf(":");
  const offset = Number(raw.slice(0, colon));
  if (colon < 1 || !Number.isInteger(offset) || offset < 0 || offset > 1000) {
    throw new Error("invalid_cursor: pass the cursor exactly as a previous core.media.list returned it");
  }
  const r2Cursor = raw.slice(colon + 1);
  return { offset, r2Cursor: r2Cursor.length > 0 ? r2Cursor : undefined };
}

function formatListCursor(position: ListPosition): string {
  return `${position.offset}:${position.r2Cursor ?? ""}`;
}

interface ListArgs {
  query?: string;
  imagesOnly?: boolean;
  limit?: number;
  cursor?: string;
}

async function listMedia(ctx: AgentToolCtx, args: ListArgs) {
  const limit = args.limit ?? LIST_DEFAULT_LIMIT;
  const needle = args.query?.trim().toLowerCase() ?? "";
  const imagesOnly = args.imagesOnly ?? true;
  const matches = (file: StoredFile) =>
    (!imagesOnly || isImage(file)) &&
    (needle.length === 0 ||
      file.key.toLowerCase().includes(needle) ||
      (file.alt ?? "").toLowerCase().includes(needle));

  const upload = ctx.services.providers.get<UploadProvider>("upload");
  const origin = await siteOrigin();
  const items: AgentMediaView[] = [];
  let position = parseListCursor(args.cursor);
  let next: ListPosition | null = null;

  for (let pages = 1; ; pages++) {
    const page = await listFiles("", position.r2Cursor);
    let i = position.offset;
    for (; i < page.files.length && items.length < limit; i++) {
      const file = page.files[i];
      if (matches(file)) items.push(toView(file, absoluteUrl(upload.url(file.key), origin)));
    }
    if (i < page.files.length) {
      // 這一頁還沒看完就湊滿了:下次從這一頁的第 i 個接著看。
      next = { offset: i, r2Cursor: position.r2Cursor };
      break;
    }
    if (!page.cursor) break; // 整個媒體庫看完了。
    position = { offset: 0, r2Cursor: page.cursor };
    if (items.length >= limit || pages >= LIST_MAX_PAGES) {
      next = position;
      break;
    }
  }

  return { items, cursor: next ? formatListCursor(next) : null };
}

// ---- upload 的摘要 ----

function hostOf(raw: string): string {
  try {
    return new URL(raw.trim()).hostname;
  } catch {
    return "";
  }
}

function clipAlt(alt: string): string {
  const flat = alt.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

/** 確認卡那一行。收到的是模型未驗證的 input(見 AgentTool.summarize),逐欄防禦性讀。 */
function summarizeUpload(args: unknown, locale: Locale): string {
  const host = hostOf(readStringArg(args, "url"));
  const alt = clipAlt(readStringArg(args, "alt"));
  if (locale === "zh-Hant") {
    const what = alt ? `圖片「${alt}」` : "一張圖片";
    return host ? `從 ${host} 上傳${what}到媒體庫` : `上傳${what}到媒體庫`;
  }
  const what = alt ? `the image "${alt}"` : "an image";
  return host ? `Upload ${what} from ${host} to the media library` : `Upload ${what} to the media library`;
}

// ---- tools ----

const MAX_MB = Math.round(MEDIA_UPLOAD_MAX_BYTES / (1024 * 1024));

export function mediaAgentTools(): AgentTool[] {
  return [
    defineAgentTool({
      name: "core.media.list",
      description:
        "List files in the site's media library: each file's key, public URL, content type, size, pixel width/height and alt text where known. " +
        "Use it to reuse an image that is already uploaded instead of uploading it again — image fields store the `key`. " +
        "`query` matches the alt text or the key, case-insensitive; keys look like core/2026/09/<id>.jpg, so \"2026/09\" finds uploads from September 2026. " +
        "Images only unless imagesOnly is false. Files come in storage order (oldest month first), a few at a time; " +
        "when `cursor` is not null there may be more matches, so pass it back to continue.",
      kind: "read",
      schema: z
        .object({
          query: z.string().max(200).optional(),
          imagesOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
          cursor: z.string().max(2000).optional(),
        })
        .strict(),
      run: (ctx, args) => listMedia(ctx, args),
    }),

    defineAgentTool({
      name: "core.media.upload",
      description:
        "Add an image to the site's media library and get back its `key`. Image fields store that key, not a URL: " +
        "for example a product's image or a post's cover is set by passing data: { image: key } or { cover: key } to the content tool. " +
        "Give exactly one source. `url`: a direct link to the image file on the public internet (not a web page that shows it); the site downloads it. " +
        "`base64`: the file's bytes, base64-encoded (a data: URL works too) — only practical for small images, so prefer `url`. " +
        `JPEG, PNG, GIF, WebP or AVIF, up to ${MAX_MB} MB; the type is read from the file itself. ` +
        "Refused: other file types (including SVG and HTML pages), private or local addresses, and links containing a username or password. " +
        "Set `alt` to a short description of the picture, such as the product name. " +
        "A picture the user attached to the chat cannot be passed here: ask them for a link to the image file, " +
        "or to upload it in the admin's media library and then find it with core.media.list.",
      kind: "write",
      // 只新增一個檔案,不動任何既有資料(外部 AI App 據此少一次警告,見 AgentTool.destructive)。
      destructive: false,
      schema: z
        .object({
          url: z.string().min(1).max(REMOTE_IMAGE_URL_MAX).optional(),
          base64: z.string().min(1).max(base64MaxChars(MEDIA_UPLOAD_MAX_BYTES)).optional(),
          alt: z.string().max(MAX_ALT_LENGTH).optional(),
        })
        .strict()
        .refine((args) => (args.url === undefined) !== (args.base64 === undefined), {
          message: "give exactly one of url or base64",
        }),
      summarize: summarizeUpload,
      run: async (ctx, args) => {
        const image =
          args.url !== undefined
            ? await fetchRemoteImage(args.url, { maxBytes: MEDIA_UPLOAD_MAX_BYTES })
            : decodeBase64Image(args.base64 ?? "", MEDIA_UPLOAD_MAX_BYTES);
        const saved = await saveMediaUpload(ctx.services, {
          filename: `image.${image.format.ext}`,
          body: new Blob([image.bytes], { type: image.format.contentType }),
          contentType: image.format.contentType,
          alt: args.alt,
        });
        return toView(saved, absoluteUrl(saved.url, await siteOrigin()));
      },
    }),
  ];
}
