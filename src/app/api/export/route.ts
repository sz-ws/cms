import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { getDB, getStorage } from "@/lib/cf";
import { getExtRuntime } from "@/ext/loader";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { getLocale } from "@/lib/i18n/server";
import {
  EXPORT_FORMAT,
  MAX_ENTRIES,
  collectExportableSettings,
  exportRecords,
  ndjsonStream,
  type ExportTypeInfo,
  type MetaRecord,
} from "@/lib/content-export";

// POST /api/export —— 全站內容匯出(NDJSON 串流下載)。格式契約寫在
// src/lib/content-export.ts 檔頭。
//
// ---- 為什麼是 POST(而不是 GET)----
// 這是 bulk data egress,守衛必須和其他敏感端點同一套:assertSameOrigin(req) +
// requireAuth("admin"),照 src/app/api/settings/route.ts 的 PUT 逐字複製。
// 但瀏覽器**不會**在同源 GET(導航或 fetch)帶 Origin header —— 用 GET 就等於
// assertSameOrigin 永遠 403,或者被迫放棄 origin 檢查(/api/media/list 就是那條路,
// 但它只是唯讀列表,不是整站傾印)。POST 一律帶 Origin,而 <form method="post">
// 送出時瀏覽器會直接把回應串流寫進磁碟,不必在記憶體裡組 Blob。兩個需求同時滿足。
//
// ---- request context 的坑 ----
// stream 的 pull() 在本函式 return 之後才被呼叫,那時 getCloudflareContext() 的
// AsyncLocalStorage 可能已經不在。所以 binding(D1/R2)與所有 request-scoped 的
// 前置資料(ext runtime、settings)都必須在 return 前算完並「傳值」給產生器。

export const dynamic = "force-dynamic";

/** `<extId>.<typeName>`;交給 D1 前先過形狀,避免拿使用者字串去撞索引。 */
const TYPE_RE = /^[a-z][a-z0-9-]{0,30}\.[A-Za-z0-9_-]{1,40}$/;
/** contents.id 是 nanoid;續抓 cursor 只允許同一組字元集。 */
const AFTER_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** R2 cursor 是 opaque base64-ish 字串;只做長度與字元集上限。 */
const CURSOR_RE = /^[A-Za-z0-9+/=_-]{1,1024}$/;

function param(url: URL, name: string, re: RegExp): string | null | false {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.length === 0) return null;
  return re.test(raw) ? raw : false;
}

/** site-export-2026-07-25.ndjson / site-export-blog.post-2026-07-25.ndjson */
function filename(type: string | null): string {
  const day = new Date().toISOString().slice(0, 10);
  const slice = type ? `-${type}` : "";
  return `site-export${slice}-${day}.ndjson`;
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const url = new URL(req.url);
  const type = param(url, "type", TYPE_RE);
  const after = param(url, "after", AFTER_RE);
  const mediaCursor = param(url, "mediaCursor", CURSOR_RE);
  if (type === false || after === false || mediaCursor === false) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  // ---- request-scoped 前置(必須在 return 之前做完)----
  const d1 = getDB();
  let r2: R2Bucket | undefined;
  try {
    r2 = getStorage();
  } catch {
    r2 = undefined; // 沒綁 R2 就沒有 media 段,不是錯誤。
  }

  const exportSettings = await collectExportableSettings();

  const locale = await getLocale();
  const types: ExportTypeInfo[] = [];
  try {
    const rt = await getExtRuntime();
    for (const ext of rt.enabled) {
      for (const ct of ext.contentTypes ?? []) {
        const label = resolveLocalizedString(ct.label, locale);
        types.push({
          type: `${ext.id}.${ct.name}`,
          ...(label ? { label } : {}),
          fields: ct.fields.map((f) => ({ key: f.key, type: f.type })),
        });
      }
    }
  } catch {
    // schema 摘要是「加分」不是必要:拿不到就給空陣列,entry 本體照常匯出。
  }

  const meta: MetaRecord = {
    kind: "meta",
    format: EXPORT_FORMAT,
    exportedAt: Date.now(),
    includes: ["setting", "media", "entry"],
    excludes: [
      {
        what: "secrets",
        reason:
          "API keys and other encrypted settings are never decrypted into an export. Not masked — absent.",
      },
      {
        what: "ext.* settings",
        reason:
          "Extension settings may be secret; a disabled extension cannot be checked, so none are exported.",
      },
      {
        what: "users",
        reason:
          "Accounts, emails and password hashes are credentials and PII, not site content.",
      },
      {
        what: "content revisions",
        reason:
          "Version history is internal editorial state and multiplies size; the current state of every entry is exported instead.",
      },
      {
        what: "media file bytes",
        reason:
          "Only an object manifest is exported. Download each file from its `url` (public, no auth) in a second step.",
      },
    ],
    types,
    filter: { type, after },
    limits: { maxEntries: MAX_ENTRIES, maxMediaObjects: 3000 },
  };

  const stream = ndjsonStream(
    exportRecords({
      d1,
      r2,
      meta,
      settings: exportSettings,
      type,
      after,
      mediaCursor,
    }),
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename(type)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
