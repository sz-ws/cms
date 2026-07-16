import type { ApiRoute } from "../types";
import type { ContentEntry, ContentProvider } from "../capabilities";
import { ContentValidationError } from "./content-provider";
import { toTypeDef } from "./runtime";
import type { DeclarativeContentType } from "./manifest";
import { displayValue, pickTitleField } from "./views/field-utils";
import { hitRateLimit } from "@/lib/rate-limit"; // public:true anonymous POST 防護用
import { sanitizePublicCreateBody } from "./public-create";
import { notifyOnPublicCreate } from "./notify"; // A:public create 成功後 best-effort 通知信

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
// handler 一律經 dispatch 層 requireAuth + mutation origin 檢查(見 route.ts)。
// NOTE:matcher 為「先註冊先贏」(route.ts matchApiRoute),故 `<type>/options` 必須
// 排在 `<type>/:id` 之前,否則 "options" 會被當成 :id 吃掉。

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
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (Number.isFinite(bytes) && bytes > MAX_BODY_BYTES) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
  }
  try {
    const j = (await req.json()) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j))
      return Response.json({ error: "invalid_input" }, { status: 400 });
    return j as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }
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

export function buildCrudRoutes(
  extId: string,
  ct: DeclarativeContentType,
): ApiRoute[] {
  const def = toTypeDef(extId, ct);
  const typeName = ct.name;

  return [
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
      method: "DELETE",
      path: `${typeName}/:id`,
      handler: async (_req, params, ctx) => {
        try {
          const p = await provider(ctx, def);
          const existing = await p.get(def.type, params.id);
          if (!existing)
            return Response.json({ error: "not_found" }, { status: 404 });
          await p.delete(def.type, params.id);
          return Response.json({ ok: true });
        } catch (e) {
          return errResponse(e);
        }
      },
    },
  ];
}
