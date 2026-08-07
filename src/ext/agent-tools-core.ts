import { z } from "zod";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_QUERY_LENGTH,
  searchContent,
} from "@/lib/search";
import { allowedSettingFields, getSetting } from "@/lib/settings";
import type { SettingField } from "@/lib/settings";
import { format, getMessages } from "@/lib/i18n/index";
import type { Locale } from "@/lib/i18n/index";
import {
  D1_QUOTA_BYTES,
  formatBytes,
  getDatabaseStats,
  getWeeklyActivity,
} from "@/components/admin/dashboard/widget-data";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { AGENT_DISPLAY_MAX_SEGMENTS } from "./agent-display";
import type { AgentDisplay } from "./agent-display";
import { defineAgentTool } from "./agent-tools";
import type { AgentTool } from "./agent-tools";
import type { ContentProvider } from "./capabilities";
import type { ExtRuntime } from "./loader";

// docs/spec-admin-agent.md §2 表格第一列:core 內建的 read tools ——
// 內容搜尋 / 讀取、settings 讀取(secret 欄位過濾)、extensions 列表,以及 1.33.0
// 起的三個統計 tool(總覽 / 活躍度 / 資料庫用量)。全部 kind:"read"。
//
// 前四個是 agent 的「定向能力」:先看得到站上有什麼(extensions)、設定成什麼樣
// (settings)、內容在哪裡(search),才談得上動手。後三個是「站的現況」——
// 被問「我有幾篇文章」時,答案該來自一次真的查詢,不是模型的印象。
//
// ── 統計 tool 的兩條紀律 ─────────────────────────────────────────────────────
// 1. **一律復用既有的聚合函式**(aggregate.ts / widget-data.ts),不重寫查詢。
//    dashboard 上的數字與 agent 說出來的數字必須是同一個來源 —— 兩份查詢遲早會
//    在某個 edge case 上給出兩個答案,而那時沒有人分得出哪一個是對的。
// 2. `run()` 回傳給模型的是**人看得懂的 JSON**(有標籤的數字),不是 widget
//    payload:模型必須能只讀文字就回答「你有 42 篇文章」。`display()` 再把同一份
//    資料轉成 widget spec —— 兩個讀者,一份事實。
//
// ── workers pool 注意事項 ────────────────────────────────────────────────────
// 本檔對 @/ext/loader 只有 `import type`(編譯期抹除),runtime 取 ExtRuntime 一律
// 走 dynamic import —— 同 @/lib/settings 的既有手法。靜態 import loader 會經
// interpret → views → next/navigation,把本檔連同它的測試一起弄成載不起來。
// **aggregate.ts 同樣只能 dynamic import**:它靜態 import 了 @/ext/loader,所以
// 它繼承了完全一樣的限制。

/** 完整 content type key:`<extId>.<typeName>`(兩段字元集皆為小寫、數字、連字號)。 */
const TYPE_KEY_RE = /^[a-z][a-z0-9-]{0,30}\.[a-z][a-z0-9-]{0,30}$/;

// ---- settings ----

/** 一筆 setting 對 agent 的樣貌。secret 沒有 `value` 這個欄位,不是空值。 */
export interface AgentSettingView {
  key: string;
  label: string;
  type: SettingField["type"];
  secret: boolean;
  value?: unknown;
}

/**
 * 依 field 定義讀 settings,secret 的**一次都不讀**。
 *
 * spec §1.3 的要求是「secret 類 setting 值永不進 args/result 記錄」。做法有兩種:
 * 讀出來再遮罩,或根本不讀。這裡選後者 —— 遮罩要成立,得倚賴之後每一個經手 result
 * 的地方(audit 寫入、面板渲染、錯誤回報)都不出錯;而「從未取得明文」是一個不需要
 * 任何人維持紀律就成立的性質。少一次解密也少一個 SECRETS_KEY 缺失就整個 tool 掛掉
 * 的失敗點。
 *
 * `read` 由呼叫端注入(正式路徑是 getSetting),讓測試能斷言的不只是「輸出沒有
 * 密文」,而是「secret key 從頭到尾沒被讀過」—— 那才是真正要守住的東西。
 */
export async function readSettingsSafely(
  fields: ReadonlyMap<string, SettingField>,
  read: (key: string) => Promise<unknown>,
  keys?: readonly string[],
): Promise<AgentSettingView[]> {
  const wanted = keys ? new Set(keys) : null;
  const out: AgentSettingView[] = [];
  for (const [key, field] of fields) {
    if (wanted && !wanted.has(key)) continue;
    const view: AgentSettingView = {
      key,
      label: resolveLocalizedString(field.label, "en") ?? key,
      type: field.type,
      secret: field.secret === true,
    };
    // 順序很重要:secret 判定必須在 read 之前,不能先讀再決定要不要露出。
    out.push(field.secret === true ? view : { ...view, value: await read(key) });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

// ---- extensions ----

export interface AgentExtensionView {
  id: string;
  name: string;
  version: string;
  coreApi: string;
  /** code = 編譯期註冊;declarative = runtime 安裝的 manifest。 */
  kind: "code" | "declarative";
  description?: string;
  /** 該 extension 宣告的完整 content type key(agent 的 content.* tools 由此而來)。 */
  contentTypes: string[];
}

export interface AgentExtensionListing {
  enabled: AgentExtensionView[];
  /** enabled 但無法載入的列(coreApi 不相容、migration 失敗…)。 */
  unavailable: { id: string; reason: string }[];
}

/**
 * ExtRuntime → 給 agent 看的清單。純函式(runtime 由呼叫端取得),因為「哪些
 * extension 存在」是模型後續每一步推理的地基,而地基要能被測試直接斷言。
 *
 * unavailable 也一併回報,是刻意的:agent 最常被問的問題之一是「為什麼 X 沒作用」,
 * 而答案往往就在這份名單裡。少了它,模型只會看到「沒有這個 extension」然後開始猜。
 */
export function describeExtensions(
  rt: Pick<ExtRuntime, "enabled" | "all" | "unavailableById">,
): AgentExtensionListing {
  const codeIds = new Set(rt.all.map((e) => e.id));
  return {
    enabled: rt.enabled.map((ext) => ({
      id: ext.id,
      name: resolveLocalizedString(ext.name, "en") ?? ext.id,
      version: ext.version,
      coreApi: ext.coreApi,
      kind: codeIds.has(ext.id) ? "code" : "declarative",
      description: resolveLocalizedString(ext.description, "en"),
      contentTypes: (ext.contentTypes ?? []).map(
        (ct) => `${ext.id}.${ct.name}`,
      ),
    })),
    unavailable: [...rt.unavailableById].map(([id, issue]) => ({
      id,
      reason:
        issue.kind === "core-api-incompatible"
          ? `core-api-incompatible (needs ${issue.coreApi}, core is ${issue.coreVersion})`
          : issue.kind,
    })),
  };
}

// ---- 統計(1.33.0)----

/** `core.stats.overview` 回給模型的形狀。每個數字都帶標籤,不用猜欄位語意。 */
export interface AgentStatsOverview {
  totalEntries: number;
  totalPublished: number;
  totalDrafts: number;
  typeCount: number;
  userCount: number;
  types: {
    /** 完整 type key(`<extId>.<typeName>`),可直接餵給 content.* tools。 */
    type: string;
    label: string;
    extension: string;
    total: number;
    published: number;
    drafts: number;
  }[];
}

/** `core.stats.activity` 回給模型的形狀。dailyCounts 由舊到新。 */
export interface AgentStatsActivity {
  windowDays: number;
  entriesCreated: number;
  previousWindowCreated: number;
  change: { direction: "up" | "down" | "flat"; amount: number };
  dailyCounts: number[];
}

/** `core.stats.storage` 回給模型的形狀。拿不到 DB 大小時 available:false。 */
export type AgentStatsStorage =
  | { available: false; reason: string }
  | {
      available: true;
      plan: "free" | "paid";
      usedBytes: number;
      usedLabel: string;
      quotaBytes: number;
      quotaLabel: string;
      usedPercent: number;
    };

// ── display 的防禦性讀取 ─────────────────────────────────────────────────────
// display 收到的是「這個 tool 自己 run() 剛回傳的東西」,比 summarize 的 LLM input
// 可信得多 —— 但它仍然可能是空的(全新站台一筆內容都沒有)、或在某次重構之後不再
// 是預期的形狀。這幾支小函式讓每個 display 都能逐欄讀取而不必寫 try/catch:讀不到
// 就回 null,最後由呼叫端決定「整張卡不畫」。

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(
  source: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 字串欄位收進 agentDisplaySchema 的上限內。
 *
 * 截的是**標籤**,不是數字 —— 一個過長的 content type 名字不該讓整張卡消失,而
 * schema 對超長字串是整份拒收(見 agent-display.ts:不畫半殘的卡)。所以在送進去
 * 之前就先收好,讓「拒收」只發生在真正壞掉的形狀上。
 */
function clip(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && value.trim().length > 0 ? value : fallback;
  return raw.length > 120 ? `${raw.slice(0, 119)}…` : raw;
}

/** 各 content type 的筆數 → bar-list。段落數不限,正好是 bar-list 存在的理由。 */
function overviewDisplay(
  result: unknown,
  locale: Locale,
): AgentDisplay | undefined {
  const row = readRecord(result);
  const types = Array.isArray(row?.types) ? row.types : [];
  const segments = types
    .map(readRecord)
    .map((t) => {
      const value = readNumber(t, "total");
      const id = typeof t?.type === "string" ? t.type : null;
      return value === null || id === null
        ? null
        : { id: clip(id, "?"), label: clip(t?.label, id), value };
    })
    .filter((s): s is { id: string; label: string; value: number } => s !== null)
    // 已依總筆數排序(aggregate.ts),所以截掉的是最小的那幾個。超過上限本來就
    // 讀不出比例,而**卡片不是唯一的出口** —— 完整清單在 run() 的結果裡,模型
    // 照樣讀得到,回答不會因此少一個型別。
    .slice(0, AGENT_DISPLAY_MAX_SEGMENTS);
  if (segments.length === 0) return undefined;
  return {
    kind: "proportion",
    preset: "bar-list",
    data: { label: getMessages(locale)["dashboard.widgets.distribution"], segments },
  };
}

/** 每日新增筆數 → trend-bars。 */
function activityDisplay(
  result: unknown,
  locale: Locale,
): AgentDisplay | undefined {
  const row = readRecord(result);
  const created = readNumber(row, "entriesCreated");
  const daily = Array.isArray(row?.dailyCounts) ? row.dailyCounts : [];
  const series = daily.filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  if (created === null || series.length === 0) return undefined;

  const change = readRecord(row?.change);
  const amount = readNumber(change, "amount");
  const direction = change?.direction;
  const m = getMessages(locale);
  const days = series.length;

  return {
    kind: "trend",
    preset: "trend-bars",
    data: {
      label: `${m["dashboard.widgets.activity"]} · ${format(m["agent.display.activityWindow"], { days })}`,
      value: created,
      ...(amount !== null &&
      (direction === "up" || direction === "down" || direction === "flat")
        ? {
            delta: {
              value: amount,
              direction,
              caption: format(m["agent.display.activityCompare"], { days }),
            },
          }
        : {}),
      series,
    },
  };
}

/** D1 已用 vs 配額 → progress-ring。 */
function storageDisplay(
  result: unknown,
  locale: Locale,
): AgentDisplay | undefined {
  const row = readRecord(result);
  if (row?.available !== true) return undefined;
  const used = readNumber(row, "usedBytes");
  const quota = readNumber(row, "quotaBytes");
  const percent = readNumber(row, "usedPercent");
  if (used === null || quota === null || quota <= 0) return undefined;

  const m = getMessages(locale);
  const quotaLabel = clip(row.quotaLabel, `${quota}`);
  const usedLabel = clip(row.usedLabel, `${used}`);
  return {
    kind: "proportion",
    preset: "progress-ring",
    data: {
      label: clip(
        `${m["dashboard.widgets.database"]} · ${m["dashboard.widgets.databaseQuota"]} ${quotaLabel}`,
        m["dashboard.widgets.database"],
      ),
      segments: [{ id: "used", label: m["agent.display.dbUsed"], value: used }],
      total: quota,
      valueLabel: clip(
        percent === null ? usedLabel : `${usedLabel} · ${percent}%`,
        usedLabel,
      ),
    },
  };
}

// ---- tools ----

/**
 * core 內建 read tools。每次呼叫回傳新陣列(registry 負責去重與擁有權)。
 */
export function coreAgentTools(): AgentTool[] {
  return [
    defineAgentTool({
      name: "core.content.search",
      description:
        "Full-text search across every content entry on the site (drafts included), ranked by relevance. " +
        "Use this to locate content when you do not know which content type it lives in; " +
        "each hit carries the entry id and its type key, which core.content.get and the content.* tools take. " +
        `The query needs at least ${MIN_QUERY_LENGTH} characters.`,
      kind: "read",
      schema: z
        .object({
          q: z.string().min(MIN_QUERY_LENGTH),
          limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
        })
        .strict(),
      run: async (_ctx, args) =>
        searchContent(args.q, args.limit ?? DEFAULT_SEARCH_LIMIT),
    }),

    defineAgentTool({
      name: "core.content.get",
      description:
        "Read one content entry by its type key and id, including every field value. " +
        'The type key is "<extensionId>.<typeName>", e.g. "gallery.item". Returns null when there is no such entry.',
      kind: "read",
      schema: z
        .object({
          type: z.string().regex(TYPE_KEY_RE, "expected <extId>.<typeName>"),
          id: z.string().min(1),
        })
        .strict(),
      run: async (ctx, args) => {
        const provider = ctx.services.providers.get<ContentProvider>("content");
        return provider.get(args.type, args.id);
      },
    }),

    defineAgentTool({
      name: "core.settings.get",
      description:
        "Read the site's settings — core settings plus every enabled extension's. " +
        "Omit `keys` to list them all, which is also how you discover what keys exist. " +
        "Secret settings (API keys and the like) are listed with secret: true and NO value; their values are never readable.",
      kind: "read",
      schema: z
        .object({ keys: z.array(z.string().min(1)).optional() })
        .strict(),
      run: async (_ctx, args) =>
        readSettingsSafely(
          await allowedSettingFields(),
          (key) => getSetting(key),
          args.keys,
        ),
    }),

    defineAgentTool({
      name: "core.extensions.list",
      description:
        "List the extensions installed on this site: id, name, version, whether it is a code or declarative extension, " +
        "and the content types it declares. Also reports extensions that are enabled but could not be loaded, with the reason. " +
        "Start here when you need to know what this site can actually do.",
      kind: "read",
      schema: z.object({}).strict(),
      run: async () => {
        // 見檔頭:loader 只能 dynamic import。
        const { getExtRuntime } = await import("./loader");
        return describeExtensions(await getExtRuntime());
      },
    }),

    defineAgentTool({
      name: "core.stats.overview",
      description:
        "How much content this site has, broken down by content type: total entries, published vs drafts, " +
        "the number of content types and the number of user accounts. " +
        "Use this for any question about totals or 'how many' — it counts the real rows, so never estimate instead. " +
        "For what changed recently use core.stats.activity; to find a specific entry use core.content.search.",
      kind: "read",
      schema: z.object({}).strict(),
      run: async (): Promise<AgentStatsOverview> => {
        // aggregate.ts 靜態 import 了 @/ext/loader,所以它繼承同一條限制(見檔頭)。
        const { getDashboardData } = await import(
          "@/components/admin/dashboard/aggregate"
        );
        const data = await getDashboardData();
        // 刻意不帶 data.recent:那是 dashboard 的「最近更新」動態,對 agent 而言
        // 是一份會把 tool_result 預算吃掉一大塊的清單,而且 core.content.search
        // 本來就找得到。這個 tool 回答的是「有多少」,不是「有哪些」。
        return {
          totalEntries: data.totalEntries,
          totalPublished: data.totalPublished,
          totalDrafts: data.totalDrafts,
          typeCount: data.typeCount,
          userCount: data.userCount,
          types: data.types.map((t) => ({
            type: t.typeKey,
            label: t.typeLabel,
            extension: t.extName,
            total: t.total,
            published: t.published,
            drafts: t.drafts,
          })),
        };
      },
      display: overviewDisplay,
    }),

    defineAgentTool({
      name: "core.stats.activity",
      description:
        "How much content was created recently: one count per day over the last two weeks, the window total, " +
        "the same figure for the preceding window, and whether it went up or down. " +
        "Use this for questions about momentum, trends or 'has it been busy lately'. " +
        "For the standing totals use core.stats.overview.",
      kind: "read",
      schema: z.object({}).strict(),
      run: async (): Promise<AgentStatsActivity> => {
        const trend = await getWeeklyActivity(Date.now());
        const dailyCounts = trend.series ?? [];
        // getWeeklyActivity 的契約是 widget 的 TrendWidgetData(value 可以是字串)。
        // 這裡回給模型的必須是數字,拿不到就從每日數加回來 —— 兩者本來就相等。
        const entriesCreated =
          typeof trend.value === "number"
            ? trend.value
            : dailyCounts.reduce((sum, n) => sum + n, 0);
        const direction = trend.delta?.direction ?? "flat";
        const amount = trend.delta?.value ?? 0;
        // delta 是絕對值 + 方向(widget 契約),前一段窗的總數要反推回來 ——
        // 模型被問「比上兩週多還少」時,兩個數字並排比一個「+7」好讀得多。
        const previousWindowCreated =
          direction === "up"
            ? entriesCreated - amount
            : direction === "down"
              ? entriesCreated + amount
              : entriesCreated;
        return {
          windowDays: dailyCounts.length,
          entriesCreated,
          previousWindowCreated: Math.max(0, previousWindowCreated),
          change: { direction, amount },
          dailyCounts,
        };
      },
      display: activityDisplay,
    }),

    defineAgentTool({
      name: "core.stats.storage",
      description:
        "How much of the D1 database quota this site has used, in bytes and as a percentage, " +
        "plus which plan's quota applies. Use this when asked whether the site is running out of room. " +
        "Reports available: false when the database size cannot be read.",
      kind: "read",
      schema: z.object({}).strict(),
      run: async (): Promise<AgentStatsStorage> => {
        const stats = await getDatabaseStats();
        // 拿不到大小(binding 缺席、build 期)是**正常狀況**,不是錯誤 —— 回一個
        // 說得清楚的形狀,讓模型能照實說「讀不到」,而不是丟一個例外讓它去猜。
        if (!stats) {
          return { available: false, reason: "database_size_unavailable" };
        }
        const plan =
          (await getSetting<string>("core.d1.plan", "free")) === "paid"
            ? "paid"
            : "free";
        const quotaBytes = D1_QUOTA_BYTES[plan];
        return {
          available: true,
          plan,
          usedBytes: stats.bytes,
          usedLabel: formatBytes(stats.bytes),
          quotaBytes,
          quotaLabel: formatBytes(quotaBytes),
          usedPercent: Math.round((stats.bytes / quotaBytes) * 100),
        };
      },
      display: storageDisplay,
    }),
  ];
}
