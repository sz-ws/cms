import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { declarativeExtensions as dxTable } from "@/lib/schema";
import { defineAgentTool, readStringArg } from "../agent-tools";
import type { AgentTool, AgentToolCtx } from "../agent-tools";
import type { Locale } from "@/lib/i18n/index";
import type { ContentEntry, ContentProvider, ContentTypeDef } from "../capabilities";
import { toTypeDef } from "./runtime";
import { parseManifest } from "./manifest";
import type { DeclarativeContentType, DeclarativeManifest } from "./manifest";
import { submissionTypeNames } from "./submission";
import { contentDataSchema, describeFields } from "./agent-field-schema";
import { displayValue, pickTitleField } from "./views/field-utils";
import { resolveLocalizedString } from "@/lib/i18n/localized";

// docs/spec-admin-agent.md §2 最值錢的一步:每個 declarative content type 自動長出
// list/get(read)+ create/update/delete(write)tools,schema 從 manifest fields
// 衍生。manifest 本來就是完整 schema,不該再要求任何人為 AI 重寫一次 —— 裝一個
// extension = agent 自動會操作它。
//
// ── 為什麼住在 dx/ 而且是純模組 ─────────────────────────────────────────────
// 生成規則屬於「從 manifest 衍生 declarative 行為」這一層(同 crud.ts / interpret)。
// 但**不**放進 interpret.tsx:它經 views 拉進 next/navigation,在 workers pool 測試
// 環境載不起來(同 submission.ts / schedule-jobs.ts / dashboard-cards.ts 的既有決策)。
// 「submission 到底會不會長出 create/update」是本檔最重要的正確性需求,必須能被測試
// 直接斷言,不能只存在於一個測不到的檔案裡。
//
// ── 為什麼從 declarative_extensions 列讀,而不是從 Extension 讀 ────────────────
// submission 判定需要看整份 manifest 的 publicRoutes(見 submission.ts 檔頭的規則 c),
// 而 Extension 上的 publicRoutes 已被 interpret 編譯成 matcher 函式,原始 view/
// contentType 資訊不復存在。改讀原始列 = 判定與 interpret 用的是同一份輸入,
// 兩邊不可能分叉(同 type-directory.ts 選擇讀原始列的理由)。
//
// ── write tools 在 Phase A 的地位 ──────────────────────────────────────────
// create/update/delete 都帶 kind:"write" 並實作了 execute,但**沒有任何** loop 內
// 執行 write 的路徑 —— 那條路徑不存在,而且照 spec §1.2 它永遠不該存在。write 只會
// 在 Phase C 的 /execute(人工按下確認後、重新驗 schema、重新驗 admin、記 audit)
// 被呼叫。

/** 每頁上限,對齊 CoreContentProvider 的 PER_PAGE_CAP 與 crud.ts。 */
const MAX_PER_PAGE = 100;
const DEFAULT_PER_PAGE = 20;

/**
 * content type key(`<extId>.<typeName>`)→ tool name 的中段。
 *
 * `.` 換成 `_`(gallery.item → gallery_item),照 spec §2 的例子
 * `content.gallery_item.list`:tool name 本身以 `.` 分段,type key 內層的 `.` 若
 * 原樣保留就會讓 name 從三段變成四段,解析與展示都得多一套規則。extension id
 * (`^[a-z][a-z0-9-]{1,30}$`)與 content type name(`^[a-z][a-z0-9-]{0,30}$`)兩者
 * 的字元集都不含底線,所以壓縮之後仍然一一對應,不會有兩個 type 撞名。
 */
export function contentToolSlug(extId: string, typeName: string): string {
  return `${extId}_${typeName}`;
}

/** tool 執行時取得 content provider,並註冊 type def 供 provider 驗證(同 crud.ts)。 */
async function contentProvider(
  ctx: AgentToolCtx,
  def: ContentTypeDef,
): Promise<ContentProvider> {
  const provider = ctx.services.providers.get<ContentProvider>("content");
  await provider.ensureType(def);
  return provider;
}

/**
 * list 回傳的單列。刻意**不**帶 `data`:一頁 100 筆完整文件會把 LLM 的脈絡塞爆,
 * 而 list 的用途是「找到那一筆」,不是「讀那一筆」——讀請走同組的 get。title 由
 * 既有的 pickTitleField/displayValue 推導(與 collection view、relation picker 同
 * 一套規則),否則列表會變成一串 nanoid,模型無從挑選。
 */
export interface AgentContentSummary {
  id: string;
  title: string;
  slug: string | null;
  status: "draft" | "published";
  locale?: string;
  updatedAt: number;
}

function toSummary(
  ct: DeclarativeContentType,
  entry: ContentEntry,
): AgentContentSummary {
  const titleField = pickTitleField(ct.fields, ct.slugField);
  const raw = titleField ? entry.data[titleField.key] : undefined;
  const title =
    (titleField ? displayValue(titleField, raw) : "").trim() ||
    entry.slug ||
    entry.id;
  return {
    id: entry.id,
    title,
    slug: entry.slug,
    status: entry.status,
    locale: entry.locale,
    updatedAt: entry.updatedAt,
  };
}

/** 排序鍵:宣告過的欄位 + 兩個 row 時戳。限成 enum 讓模型不必猜。 */
function sortSchema(ct: DeclarativeContentType): z.ZodType<string> {
  const keys: string[] = [
    ...ct.fields.map((f) => f.key),
    "createdAt",
    "updatedAt",
  ];
  return z.enum(keys);
}

/** 人類可讀的 type 標題(給 LLM 看的 description 用;locale-agnostic 取 en)。 */
function typeLabel(ct: DeclarativeContentType): string {
  return resolveLocalizedString(ct.label, "en") ?? ct.name;
}

/**
 * 同一個標題,但解成 admin 的介面語言 —— 確認卡摘要(summarize)用。
 *
 * 與上面那支分開,是因為兩邊的讀者不同:description 給 LLM 看,固定英文才不會讓
 * prompt 的語言隨站台設定飄移;摘要給人看,一個標了 `{ "zh-Hant": "作品" }` 的
 * manifest 就該在卡片上寫「作品」,而不是它的英文名。
 */
function localizedTypeLabel(ct: DeclarativeContentType, locale: Locale): string {
  return resolveLocalizedString(ct.label, locale) ?? ct.name;
}

/**
 * update 摘要的括號段:`(id: abc;3 個欄位)`。
 *
 * id 或 data 任一缺席就整段省略 —— 摘要收到的是模型未經驗證的 input(見
 * AgentTool.summarize),半句「(id: ;0 個欄位)」比沒有括號更難讀,也更容易讓
 * admin 誤以為那是真的參數。
 */
function updateTarget(args: unknown, locale: Locale): string {
  const id = readStringArg(args, "id");
  const data =
    typeof args === "object" && args !== null
      ? (args as { data?: unknown }).data
      : undefined;
  const fieldCount =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? Object.keys(data).length
      : -1;
  if (id.length === 0 || fieldCount < 0) return "";
  return locale === "zh-Hant"
    ? `(id: ${id};${fieldCount} 個欄位)`
    : ` (id: ${id}; ${fieldCount} fields)`;
}

/**
 * 為單一 declarative content type 產生 agent tools。
 *
 * `isSubmission`(收件匣型別)由呼叫端依整份 manifest 判定後傳入 —— 判定需要看
 * publicRoutes,本函式只拿得到單一 content type(與 buildCrudRoutes 同簽章理由)。
 * 收件匣的收窄與 crud.ts 對齊:**不生成 create 與 update**。
 *   - update:別人寄來的訊息不可變(crud.ts 已把 PUT 收窄成 403)。
 *   - create:crud.ts 保留 POST,是因為那是匿名訪客投遞表單的入口;而 agent 站在
 *     站方這一側,「代替訪客偽造一封來信」在語意上不成立,長出這個 tool 只會給
 *     模型一個製造假資料的機會。
 *   - list/get/delete 照舊 —— delete 尤其要留,既有的 schedule[] deleteOlderThan
 *     保留策略就是走同一個 provider.delete。
 */
export function contentTypeAgentTools(
  extId: string,
  ct: DeclarativeContentType,
  isSubmission = false,
): AgentTool[] {
  const def = toTypeDef(extId, ct);
  const slug = contentToolSlug(extId, ct.name);
  const label = typeLabel(ct);
  const fieldsDoc = describeFields(ct.fields);
  const noun = isSubmission ? "submission" : "entry";

  const readTools: AgentTool[] = [
    defineAgentTool({
      name: `content.${slug}.list`,
      description:
        `List "${label}" (${def.type}) entries, newest first by default. ` +
        `Returns a summary per ${noun} (id, title, slug, status, locale, updatedAt) plus the total count — ` +
        `use content.${slug}.get for the full field values. Paginated; perPage is capped at ${MAX_PER_PAGE}.`,
      kind: "read",
      schema: z
        .object({
          page: z.number().int().min(1).optional(),
          perPage: z.number().int().min(1).max(MAX_PER_PAGE).optional(),
          status: z.enum(["draft", "published"]).optional(),
          sort: sortSchema(ct).optional(),
          dir: z.enum(["asc", "desc"]).optional(),
        })
        .strict(),
      run: async (ctx, args) => {
        const provider = await contentProvider(ctx, def);
        const { items, total } = await provider.query(def.type, {
          filter: args.status ? { status: args.status } : undefined,
          sort: args.sort
            ? { field: args.sort, dir: args.dir ?? "desc" }
            : undefined,
          page: args.page ?? 1,
          perPage: args.perPage ?? DEFAULT_PER_PAGE,
        });
        return { items: items.map((e) => toSummary(ct, e)), total };
      },
    }),
    defineAgentTool({
      name: `content.${slug}.get`,
      description:
        `Read one "${label}" (${def.type}) ${noun} by id, including every field value. ` +
        `Ids come from content.${slug}.list or core.content.search. Returns null when there is no such ${noun}. ` +
        `Fields: ${fieldsDoc}`,
      kind: "read",
      schema: z.object({ id: z.string().min(1) }).strict(),
      run: async (ctx, args) => {
        const provider = await contentProvider(ctx, def);
        return provider.get(def.type, args.id);
      },
    }),
  ];

  const deleteTool = defineAgentTool({
    name: `content.${slug}.delete`,
    description:
      `Permanently delete one "${label}" (${def.type}) ${noun} by id. This cannot be undone.`,
    kind: "write",
    schema: z.object({ id: z.string().min(1) }).strict(),
    summarize: (args, locale) => {
      const l = localizedTypeLabel(ct, locale);
      const id = readStringArg(args, "id");
      if (locale === "zh-Hant") {
        // 「無法復原」留在最後:確認卡只有一行,最重的那句話要在句尾被讀到。
        return id
          ? `永久刪除一筆「${l}」(id: ${id})—— 無法復原`
          : `永久刪除一筆「${l}」—— 無法復原`;
      }
      return id
        ? `Permanently delete one "${l}" entry (id: ${id}) — cannot be undone`
        : `Permanently delete one "${l}" entry — cannot be undone`;
    },
    run: async (ctx, args) => {
      const provider = await contentProvider(ctx, def);
      const existing = await provider.get(def.type, args.id);
      // 不存在就當場說清楚。讓 provider.delete 靜默成功會讓確認卡回報「已刪除」,
      // 而其實什麼都沒發生 —— 對確認制而言,那是最糟的一種回報。
      if (!existing) throw new Error(`not_found: ${args.id}`);
      await provider.delete(def.type, args.id);
      return { deleted: args.id };
    },
  });

  if (isSubmission) return [...readTools, deleteTool];

  return [
    ...readTools,
    defineAgentTool({
      name: `content.${slug}.create`,
      description:
        `Create a new "${label}" (${def.type}) entry. Defaults to draft status. ` +
        `The slug is derived automatically unless given. Fields: ${fieldsDoc}`,
      kind: "write",
      schema: z
        .object({
          data: contentDataSchema(ct.fields, "create"),
          status: z.enum(["draft", "published"]).optional(),
          slug: z.string().min(1).optional(),
        })
        .strict(),
      summarize: (_args, locale) => {
        const l = localizedTypeLabel(ct, locale);
        return locale === "zh-Hant"
          ? `建立一筆新的「${l}」`
          : `Create a new "${l}" entry`;
      },
      run: async (ctx, args) => {
        const provider = await contentProvider(ctx, def);
        return provider.create(def.type, {
          ...args.data,
          ...(args.status ? { status: args.status } : {}),
          ...(args.slug ? { slug: args.slug } : {}),
        });
      },
    }),
    defineAgentTool({
      name: `content.${slug}.update`,
      description:
        `Update one "${label}" (${def.type}) entry by id. Only the fields given in \`data\` change; ` +
        `everything else keeps its current value, so read the entry first only when you need the old values. ` +
        `Fields: ${fieldsDoc}`,
      kind: "write",
      schema: z
        .object({
          id: z.string().min(1),
          data: contentDataSchema(ct.fields, "update"),
          status: z.enum(["draft", "published"]).optional(),
        })
        .strict(),
      summarize: (args, locale) => {
        const l = localizedTypeLabel(ct, locale);
        const target = updateTarget(args, locale);
        return locale === "zh-Hant"
          ? `更新一筆「${l}」${target}`
          : `Update one "${l}" entry${target}`;
      },
      run: async (ctx, args) => {
        const provider = await contentProvider(ctx, def);
        return provider.update(def.type, args.id, {
          ...args.data,
          ...(args.status ? { status: args.status } : {}),
        });
      },
    }),
    deleteTool,
  ];
}

/**
 * 整份 manifest → agent tools。submission 判定在此做一次,往下傳 —— 與 interpret
 * 對 admin/public/API 三個 surface 的處理方式相同(判定一次,不可能分叉)。
 */
export function manifestAgentTools(manifest: DeclarativeManifest): AgentTool[] {
  const submissions = submissionTypeNames(manifest);
  return (manifest.contentTypes ?? []).flatMap((ct) =>
    contentTypeAgentTools(manifest.id, ct, submissions.has(ct.name)),
  );
}

/**
 * 所有 enabled declarative extension 的 content type tools。
 *
 * 壞掉的列(非 JSON / manifest 驗不過)一律跳過,絕不 throw:agent 面板不該因為
 * 某個 extension 的資料有問題就整個打不開(同 loader §5 的紀律)。
 *
 * 已知的一處與 loader 不一致:loader 會跳過「id 與 code extension 撞名」的
 * declarative 列(core-v2 §3.3),這裡不會 —— 判定需要 import extensions/registry,
 * 而那條 import 鏈有既有的 module-init TDZ 問題(見 dx/runtime.ts 對 lazy import
 * loader 的說明)。影響很小:撞名本身已是 loader 會記錄的錯誤狀態,而後果只是多出
 * 幾個指向孤兒 contents 列的 tool。若 Phase C 之後覺得這道縫該補,正確做法是讓
 * loader 匯出一份「被跳過的 id」清單,而不是在這裡再重算一次撞名判定。
 */
export async function listDeclarativeAgentTools(): Promise<AgentTool[]> {
  const rows = await db()
    .select({ id: dxTable.id, manifest: dxTable.manifest })
    .from(dxTable)
    .where(sql`${dxTable.enabled} = 1`);

  const tools: AgentTool[] = [];
  for (const row of rows) {
    let json: unknown;
    try {
      json = JSON.parse(row.manifest);
    } catch {
      continue; // 壞列:loader 已在別處記錄。
    }
    const parsed = parseManifest(json);
    if (!parsed.ok || !parsed.manifest) continue;
    tools.push(...manifestAgentTools(parsed.manifest));
  }
  return tools;
}
