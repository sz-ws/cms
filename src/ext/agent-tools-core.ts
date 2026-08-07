import { z } from "zod";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_QUERY_LENGTH,
  searchContent,
} from "@/lib/search";
import { allowedSettingFields, getSetting } from "@/lib/settings";
import type { SettingField } from "@/lib/settings";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { defineAgentTool } from "./agent-tools";
import type { AgentTool } from "./agent-tools";
import type { ContentProvider } from "./capabilities";
import type { ExtRuntime } from "./loader";

// docs/spec-admin-agent.md §2 表格第一列:core 內建的 read tools ——
// 內容搜尋 / 讀取、settings 讀取(secret 欄位過濾)、extensions 列表。全部 kind:"read"。
//
// 這四個是 agent 的「定向能力」:先看得到站上有什麼(extensions)、設定成什麼樣
// (settings)、內容在哪裡(search),才談得上動手。
//
// ── workers pool 注意事項 ────────────────────────────────────────────────────
// 本檔對 @/ext/loader 只有 `import type`(編譯期抹除),runtime 取 ExtRuntime 一律
// 走 dynamic import —— 同 @/lib/settings 的既有手法。靜態 import loader 會經
// interpret → views → next/navigation,把本檔連同它的測試一起弄成載不起來。

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
  ];
}
