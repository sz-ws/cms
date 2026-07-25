import type { ApiRoute } from "../types";
import type { ContentEntry, ContentProvider } from "../capabilities";
import { ContentValidationError } from "./content-provider";
import { toTypeDef } from "./runtime";
import type { DeclarativeContentType } from "./manifest";
import { displayValue, pickTitleField } from "./views/field-utils";
import { hitRateLimit } from "@/lib/rate-limit"; // public:true anonymous POST 防護用
import { sanitizePublicCreateBody } from "./public-create";
import { notifyOnPublicCreate } from "./notify"; // A:public create 成功後 best-effort 通知信
import { getRevision, listRevisions } from "@/lib/revisions";
import { restoreRevision, RevisionRestoreError } from "@/lib/revision-restore";
import { readBoundedJsonObject } from "@/lib/body-limit";
import { isSubmissionState } from "./submission";
import {
  deleteSubmissionRecord,
  setSubmissionReplied,
  setSubmissionState,
  stampNewSubmission,
} from "@/lib/submissions";

const HONEYPOT_KEY = "_hp"; // public content create only;填了 → 靜默丟棄(201)
const PUBLIC_CREATE_LIMIT = 20;
const PUBLIC_CREATE_WINDOW_MS = 60_000; // 1 分鐘 20 次

async function protectPublicCreate(
  req: Request,
  extId: string,
  typeName: string,
  ct: DeclarativeContentType,
): Promise<Response | null> {
  if (!ct.public) return null;
  // 1) rate limit by (extId,typeName,IP)
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const blocked = await hitRateLimit(`${extId}:${typeName}:${ip}`, {
    namespace: "public-content-create",
    limit: PUBLIC_CREATE_LIMIT,
    windowMs: PUBLIC_CREATE_WINDOW_MS,
  });
  if (blocked) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  return null;
}

// core-v2 §3.3:auto-CRUD routes for one content type。
//   GET    /api/ext/<id>/<type>          list(query params: page, perPage, sort, dir, status)
//   POST   /api/ext/<id>/<type>          create
//   GET    /api/ext/<id>/<type>/options  08 §2:relation picker 用的搜尋端點(?q=&limit=)
//   GET    /api/ext/<id>/<type>/:id      get one
//   PUT    /api/ext/<id>/<type>/:id      update
//   DELETE /api/ext/<id>/<type>/:id      delete
//   GET    /api/ext/<id>/<type>/:id/revisions              版本列表(不含快照本體)
//   GET    /api/ext/<id>/<type>/:id/revisions/:revId       單筆版本(含 JSON 快照)
//   POST   /api/ext/<id>/<type>/:id/revisions/:revId/restore  還原該版本
// handler 一律經 dispatch 層 requireAuth + mutation origin 檢查(見 route.ts)。
// NOTE:matcher 為「先註冊先贏」(route.ts matchApiRoute),故 `<type>/options` 必須
// 排在 `<type>/:id` 之前,否則 "options" 會被當成 :id 吃掉。revisions 三條的段數
// (3/4/5)與既有路由(1/2)都不同,matcher 先比段數,故不需要考慮順序。
//
// 版本歷史對 declarative extension 宣告的 content type 自動生效:這些路由是由
// buildCrudRoutes 為「每一個 contentType」產出的,與 core 內建型別無差別待遇 ——
// type key 一律是 `<extId>.<typeName>`(def.type),歷史表存的也是同一個 key。

const MAX_PER_PAGE = 100;
// 08 §2:options 端點回傳的最大筆數(picker 只需前幾筆;避免無界回傳)。
const OPTIONS_LIMIT_CAP = 20;
// Phase E §3: request body size cap. Bounds the whole request before it ever
// reaches JSON.parse/validateData — a Content-Length above this is rejected
// with a 413 without touching the body stream.
const MAX_BODY_BYTES = 1_000_000;

/** 08 §2:把 entry 解析成 picker 的 { id, title }。title = 標題欄位值,退回 slug/id。 */
function toOption(
  ct: DeclarativeContentType,
  entry: ContentEntry,
): { id: string; title: string } {
  const titleField = pickTitleField(ct.fields, ct.slugField);
  const raw = titleField ? entry.data[titleField.key] : undefined;
  const title =
    (titleField ? displayValue(titleField, raw) : "").trim() ||
    entry.slug ||
    entry.id;
  return { id: entry.id, title };
}

async function provider(
  ctx: { services: { providers: { get<T>(c: string): T } } },
  def: ReturnType<typeof toTypeDef>,
): Promise<ContentProvider> {
  const p = ctx.services.providers.get<ContentProvider>("content");
  // 註冊 type def 供驗證(ensureType 無 DDL 副作用,§2.4)。
  await p.ensureType(def);
  return p;
}

/**
 * Phase E §3: parse the request body as a JSON object, rejecting oversized
 * bodies BEFORE calling req.json(). Returns either the parsed object or a
 * ready-to-return error Response (413 for too-large, 400 for anything else
 * that fails to parse into a plain object) — callers just check which one
 * they got, matching the route's existing error-response style.
 */
async function readJson(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  // 上限由 readBoundedJsonObject 以**實際讀到的位元組**強制,不是 Content-Length。
  // 這條路徑對未登入者開放(declarative 的 public create),所以不能相信 header:
  // 不送 Content-Length 的 chunked 請求可以完全繞過純 header 檢查。
  const r = await readBoundedJsonObject(req, MAX_BODY_BYTES, "dx/crud");
  if (r.ok) return r.value;
  return r.reason === "too_large"
    ? Response.json({ error: "payload_too_large" }, { status: 413 })
    : Response.json({ error: "invalid_input" }, { status: 400 });
}

function errResponse(e: unknown): Response {
  if (e instanceof ContentValidationError) {
    // Structured shape so FormView can map errors back onto individual field
    // controls instead of a generic banner. `fields` may be empty (e.g. the
    // update() not-found throw) — callers fall back to `message` in that case.
    return Response.json(
      { error: "validation", message: e.message, fields: e.fields },
      { status: 400 },
    );
  }
  console.error("[dx:crud]", e);
  return Response.json({ error: "internal_error" }, { status: 500 });
}

/**
 * submission type 專屬的收件狀態路由。PATCH `<type>/:id/inbox`,body 可帶
 * `{ state?: "unread"|"read"|"archived", replied?: boolean }`(兩者皆可省略/併送)。
 *
 * 為什麼是獨立路由而不是沿用 PUT:收件狀態根本不住在 contents 表(見
 * src/lib/submissions.ts),它不是內容的一部分,而是「站方對這則訊息做了什麼」。
 * 走 PUT 會逼 provider.update 跑一次欄位驗證、寫一次 data、留一筆版本快照 ——
 * 三件對「把未讀改成已讀」完全沒有意義的事。
 */
function inboxRoute(extId: string, ct: DeclarativeContentType): ApiRoute {
  const fullType = `${extId}.${ct.name}`;
  return {
    method: "PATCH",
    path: `${ct.name}/:id/inbox`,
    handler: async (req, params) => {
      const body = await readJson(req);
      if (body instanceof Response) return body;

      const nextState = body["state"];
      const replied = body["replied"];
      if (nextState === undefined && replied === undefined) {
        return Response.json({ error: "invalid_input" }, { status: 400 });
      }
      if (nextState !== undefined && !isSubmissionState(nextState)) {
        return Response.json({ error: "invalid_state" }, { status: 400 });
      }
      if (replied !== undefined && typeof replied !== "boolean") {
        return Response.json({ error: "invalid_input" }, { status: 400 });
      }

      try {
        // 先 replied(它可能把 unread 自動推進 read),再套明確指定的 state ——
        // 這樣「標記已回覆並封存」一次送出時,操作者明講的 archived 會贏。
        if (replied !== undefined) {
          const ok = await setSubmissionReplied(fullType, params.id, replied);
          if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
        }
        if (nextState !== undefined) {
          const ok = await setSubmissionState(fullType, params.id, nextState);
          if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
        }
        return Response.json({ ok: true });
      } catch (e) {
        return errResponse(e);
      }
    },
  };
}

export function buildCrudRoutes(
  extId: string,
  ct: DeclarativeContentType,
  /**
   * 此 type 是否為收件匣型別。由 interpret 依整份 manifest 判定後傳入(判定需要看
   * publicRoutes,而本函式只拿得到單一 content type)—— 見 dx/submission.ts。
   * 省略 = 一般內容(code extension 直接呼叫本函式時的既有行為完全不變)。
   */
  isSubmission = false,
): ApiRoute[] {
  const def = toTypeDef(extId, ct);
  const typeName = ct.name;

  const routes: ApiRoute[] = [
    {
      method: "GET",
      path: typeName,
      handler: async (req, _params, ctx) => {
        try {
          const p = await provider(ctx, def);
          const url = new URL(req.url);
          const page = Number(url.searchParams.get("page") ?? "1") || 1;
          const perPageRaw = Number(url.searchParams.get("perPage") ?? "20") || 20;
          const perPage = Math.min(Math.max(1, perPageRaw), MAX_PER_PAGE);
          const sortField = url.searchParams.get("sort") ?? undefined;
          const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
          const status = url.searchParams.get("status") ?? undefined;
          const result = await p.query(def.type, {
            filter: status ? { status } : undefined,
            sort: sortField ? { field: sortField, dir } : undefined,
            page,
            perPage,
          });
          return Response.json(result);
        } catch (e) {
          return errResponse(e);
        }
      },
    },
    {
      method: "POST",
      path: typeName,
      handler: async (req, _params, ctx) => {
        try {
          const gate = await protectPublicCreate(req, extId, typeName, ct);
          if (gate) return gate;

          const body = await readJson(req);
          if (body instanceof Response) return body;

          // public:true 匿名建立的 honeypot —— 正常 UI 看不到,bot 填了就靜默丟棄(與真成功同 201)。
          let payload = body;
          if (ct.public) {
            const hp = body[HONEYPOT_KEY];
            if (typeof hp === "string" && hp.length > 0) {
              return Response.json({ ok: true }, { status: 201 });
            }
            delete body[HONEYPOT_KEY];
            payload = sanitizePublicCreateBody(body, ct);
          }

          const p = await provider(ctx, def);
          const entry = await p.create(def.type, payload);
          // 收件匣型別:落庫後補一列側表紀錄(狀態 unread)。best-effort ——
          // 寫失敗只是讓這則訊息被讀成「未讀」,剛好就是正確答案,絕不能因此讓
          // 訪客的表單送出失敗(內部已吞例外,見 src/lib/submissions.ts)。
          // 這一列同時也是 publish-due 的 NOT EXISTS 防護看得見的東西。
          if (isSubmission) {
            await stampNewSubmission(entry.id, def.type);
          }
          // A(docs/spec-declarative-notify-schedule.md):best-effort 通知信,
          // 內部已吞掉所有錯誤(見 notify.ts),絕不影響下面的 201。
          await notifyOnPublicCreate(ct, payload);
          return Response.json({ entry }, { status: 201 });
        } catch (e) {
          return errResponse(e);
        }
      },
    },
    {
      // 08 §2:relation picker 的搜尋端點。?q= 對標題欄位做 contains 搜尋
      // (走 provider 的參數化 LIKE,無字串拼接);?ids= 逗號分隔則批次解析為
      // { id, title }(顯示層 resolve 懸空/選定 id → title,見 RelationCell)。
      // 回傳 { options: { id, title }[] },上限 OPTIONS_LIMIT_CAP。
      // 必須排在 `:id` 之前(先註冊先贏)。
      method: "GET",
      path: `${typeName}/options`,
      handler: async (req, _params, ctx) => {
        try {
          const p = await provider(ctx, def);
          const url = new URL(req.url);
          const limitRaw = Number(url.searchParams.get("limit") ?? "20") || 20;
          const limit = Math.min(Math.max(1, limitRaw), OPTIONS_LIMIT_CAP);

          // ids 批次解析模式:顯示層帶已知 id 換 title(N 次 get 併發,上限 cap)。
          const idsParam = url.searchParams.get("ids");
          if (idsParam !== null) {
            const ids = idsParam
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
              .slice(0, OPTIONS_LIMIT_CAP);
            const entries = await Promise.all(
              ids.map((id) => p.get(def.type, id)),
            );
            const options = entries
              .filter((e): e is ContentEntry => e !== null)
              .map((e) => toOption(ct, e));
            return Response.json({ options });
          }

          // 搜尋模式:q 對標題欄位 contains;空 q 回最近更新的前幾筆。
          const q = (url.searchParams.get("q") ?? "").trim();
          const titleField = pickTitleField(ct.fields, ct.slugField);
          const filter =
            q.length > 0 && titleField
              ? { [titleField.key]: { contains: q } }
              : undefined;
          const { items } = await p.query(def.type, {
            filter,
            sort: { field: "updatedAt", dir: "desc" },
            page: 1,
            perPage: limit,
          });
          const options = items.map((e) => toOption(ct, e));
          return Response.json({ options });
        } catch (e) {
          return errResponse(e);
        }
      },
    },
    {
      method: "GET",
      path: `${typeName}/:id`,
      handler: async (_req, params, ctx) => {
        try {
          const p = await provider(ctx, def);
          const entry = await p.get(def.type, params.id);
          if (!entry)
            return Response.json({ error: "not_found" }, { status: 404 });
          return Response.json({ entry });
        } catch (e) {
          return errResponse(e);
        }
      },
    },
    {
      method: "PUT",
      path: `${typeName}/:id`,
      handler: async (req, params, ctx) => {
        try {
          const body = await readJson(req);
          if (body instanceof Response) return body;
          const p = await provider(ctx, def);
          const existing = await p.get(def.type, params.id);
          if (!existing)
            return Response.json({ error: "not_found" }, { status: 404 });
          const entry = await p.update(def.type, params.id, body);
          return Response.json({ entry });
        } catch (e) {
          return errResponse(e);
        }
      },
    },
    {
      // 版本列表(新→舊)。刻意不回傳每一筆的 data 快照 —— 列表只需要「誰、什麼時候、
      // 做了哪種變更」;整份文件由下面的單筆端點按需取。
      method: "GET",
      path: `${typeName}/:id/revisions`,
      handler: async (_req, params, ctx) => {
        try {
          const p = await provider(ctx, def);
          // 先確認該 entry 存在且屬於本 type,才回傳它的歷史(避免以任意 id 探測)。
          const existing = await p.get(def.type, params.id);
          if (!existing)
            return Response.json({ error: "not_found" }, { status: 404 });
          const revisions = await listRevisions(params.id);
          return Response.json({ revisions });
        } catch (e) {
          return errResponse(e);
        }
      },
    },
    {
      // 單筆版本(含 JSON 快照),供還原前預覽。
      method: "GET",
      path: `${typeName}/:id/revisions/:revId`,
      handler: async (_req, params, ctx) => {
        try {
          const p = await provider(ctx, def);
          const existing = await p.get(def.type, params.id);
          if (!existing)
            return Response.json({ error: "not_found" }, { status: 404 });
          const revision = await getRevision(params.id, params.revId);
          if (!revision)
            return Response.json({ error: "not_found" }, { status: 404 });
          return Response.json({ revision });
        } catch (e) {
          return errResponse(e);
        }
      },
    },
    {
      // 還原。權限與一般編輯相同(dispatch 的 requireAuth 預設 editor 以上)——
      // 能編輯這筆內容的人本來就能手動改回去,還原只是把它變成一次點擊。
      method: "POST",
      path: `${typeName}/:id/revisions/:revId/restore`,
      handler: async (_req, params, ctx) => {
        try {
          const p = await provider(ctx, def);
          const existing = await p.get(def.type, params.id);
          if (!existing)
            return Response.json({ error: "not_found" }, { status: 404 });
          const result = await restoreRevision(params.id, params.revId, {
            actorId: ctx.user.id,
          });
          return Response.json({ restored: result });
        } catch (e) {
          if (e instanceof RevisionRestoreError) {
            return Response.json(
              { error: e.code },
              { status: e.code === "not_found" ? 404 : 400 },
            );
          }
          return errResponse(e);
        }
      },
    },
    {
      method: "DELETE",
      path: `${typeName}/:id`,
      handler: async (_req, params, ctx) => {
        try {
          const p = await provider(ctx, def);
          const existing = await p.get(def.type, params.id);
          if (!existing)
            return Response.json({ error: "not_found" }, { status: 404 });
          await p.delete(def.type, params.id);
          // 收件紀錄一併清掉。側表已宣告 ON DELETE CASCADE,但 D1 是否開啟 FK
          // enforcement 不在本層掌控內(同 revisions 的既有處理),故明確再刪一次。
          if (isSubmission) await deleteSubmissionRecord(params.id);
          return Response.json({ ok: true });
        } catch (e) {
          return errResponse(e);
        }
      },
    },
  ];

  if (!isSubmission) return routes;

  // ── submission 的路由收窄 ────────────────────────────────────────────────
  // 訊息是不可變的:站方沒有理由改寫別人寄來的內容。所以 PUT 換成明確的 403
  // (比讓它落到 matcher 的 404 誠實:呼叫端一看就知道是「這型別不允許」而不是
  // 「路徑打錯」),revisions 三條路由整組不生成 —— 一則永遠不會被編輯的訊息,
  // 版本歷史裡只會躺著一筆和本體一模一樣的快照,純粹是浪費那一列的保留額度。
  //
  // GET / DELETE / options 原封不動。DELETE 尤其不能動:既有的 declarative
  // schedule[] deleteOlderThan 保留策略(registry 的 contact 宣告了 180 天清理)
  // 就是走 provider.delete,側表的 ON DELETE CASCADE 讓收件紀錄跟著一起走。
  const dropped = new Set([
    `PUT ${typeName}/:id`,
    `GET ${typeName}/:id/revisions`,
    `GET ${typeName}/:id/revisions/:revId`,
    `POST ${typeName}/:id/revisions/:revId/restore`,
  ]);
  return [
    ...routes.filter((r) => !dropped.has(`${r.method} ${r.path}`)),
    {
      method: "PUT",
      path: `${typeName}/:id`,
      handler: async () =>
        Response.json({ error: "immutable_submission" }, { status: 403 }),
    },
    inboxRoute(extId, ct),
  ];
}
