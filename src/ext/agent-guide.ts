import type { Locale } from "@/lib/i18n/index";
import { resolveLocalizedString, type LocalizedString } from "@/lib/i18n/localized";
import type { ExtraFieldDef, ExtraFieldsSetting } from "@/lib/extra-fields";
import { getExtraFieldsSetting } from "@/lib/extra-fields-server";
import { AI_NOTES_SETTING, normalizeAiNotes } from "@/lib/ai-notes";
import { getPlainSetting } from "@/lib/settings";
import { contentToolSlug } from "./dx/agent-tools";
import { listDeclarativeTypes } from "./dx/type-directory";
import type { DeclarativeField } from "./dx/manifest";
import { CATALOG_EXT_ID } from "./commerce-kit/catalog";
import { AGENT_GUIDE_MAX_CHARS } from "./types";
import type { ExtRuntime } from "./loader";

// 1.60.0:給 AI 的說明 —— 後台怎麼分、常見的事一步步怎麼做,外加站長自己寫的規則。
//
// 兩個讀者、同一份文字:
//   * 後台助理:接在 system prompt 最後(agent-prompt.ts)。
//   * AI 連線:MCP initialize 的 `instructions`(mcp-server.ts)—— 規格上就是給 client 的
//     模型看的「怎麼用這個伺服器」。
//
// **由站上實際啟用的東西組出來**:商品的做法只在商品目錄存在時出現、欄位清單讀自
// manifest、查訂單的做法只在有訂單工具時出現、庫存那一步看有沒有庫存工具。寫死一份
// 通用說明的話,模型會照著去叫一個不存在的 tool。
//
// 語言跟後台語言(core.locale):繁中後台給繁中說明,英文後台給英文。tool 名與欄位 key
// 不翻 —— 那是模型要原樣送回來的字。
//
// 分層同 agent-prompt.ts:buildAgentGuide 是純函式(截斷規則、哪一段何時出現都能直接
// 斷言),loadAgentGuide 才碰 DB / settings / loader。
//
// ── workers pool 注意事項 ────────────────────────────────────────────────────
// 對 @/ext/loader 只有 `import type`,runtime 走 dynamic import(同 agent-prompt.ts)。

export interface AgentGuideContentType {
  /** `<extId>.<typeName>`。 */
  typeKey: string;
  label: string;
  fields: readonly DeclarativeField[];
}

export interface AgentGuideExtension {
  id: string;
  name: string;
  guide?: LocalizedString;
}

export interface AgentGuideInput {
  locale: Locale;
  contentTypes: readonly AgentGuideContentType[];
  /** registry 裡的 tool 正名(點分)。 */
  toolNames: readonly string[];
  /** 已啟用的 extension(有 agentGuide 的才會出現在說明裡)。 */
  extensions: readonly AgentGuideExtension[];
  extraFields: ExtraFieldsSetting;
  /** 站長的說明(已經過 normalizeAiNotes)。 */
  ownerNotes: string;
  /** tool 名的寫法。MCP 傳 toWireToolName(App 那邊看到的是破折號版);省略 = 點分正名。 */
  toolName?: (name: string) => string;
}

// ── 限額 ─────────────────────────────────────────────────────────────────────
/** 插件說明段的總字元預算。 */
const MAX_EXTENSION_SECTION_CHARS = 4_000;
/** 一行欄位清單的上限(一個型別幾十個欄位時,不讓一行吃掉整份說明)。 */
const MAX_FIELD_LINE_CHARS = 500;
/** 站長說明以外的總上限(保險絲;站長說明本身已由 AI_NOTES_MAX_LENGTH 限住)。 */
const MAX_BUILT_IN_CHARS = 9_000;

const POST_TYPE_NAMES = new Set(["post", "posts", "article", "articles", "news"]);

function clip(raw: string, max: number): string {
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

/** 依語言挑一句。 */
function pick(locale: Locale, en: string, zh: string): string {
  return locale === "zh-Hant" ? zh : en;
}

function numbered(steps: readonly string[]): string[] {
  return steps.map((step, i) => `${i + 1}. ${step}`);
}

interface GuideContext {
  locale: Locale;
  has: (name: string) => boolean;
  tool: (name: string) => string;
  types: ReadonlyMap<string, AgentGuideContentType>;
  extraFields: ExtraFieldsSetting;
}

function contentTool(typeKey: string, verb: string): string {
  const dot = typeKey.indexOf(".");
  return `content.${contentToolSlug(typeKey.slice(0, dot), typeKey.slice(dot + 1))}.${verb}`;
}

function extraDefs(ctx: GuideContext, typeKey: string): readonly ExtraFieldDef[] {
  return Object.prototype.hasOwnProperty.call(ctx.extraFields, typeKey) ? ctx.extraFields[typeKey] : [];
}

/**
 * create 的欄位清單,從 manifest 讀:`name(商品名稱)、price(價格)、image(第 1 步的 key)…`。
 * media 指回上傳那一步、指向同一個 relation 目標的指回查 id 那一步。
 */
function fieldLine(
  ctx: GuideContext,
  type: AgentGuideContentType,
  refs: { mediaStep?: number; relationStep?: { to: string; step: number } },
): string {
  const { locale } = ctx;
  const parts = type.fields
    .filter((field) => field.type !== "slug")
    .map((field) => {
      if (field.type === "media" && refs.mediaStep !== undefined) {
        return `${field.key} (${pick(locale, `the key from step ${refs.mediaStep}`, `第 ${refs.mediaStep} 步的 key`)})`;
      }
      if (field.type === "relation" && refs.relationStep && field.to === refs.relationStep.to) {
        return `${field.key} (${pick(locale, `the id from step ${refs.relationStep.step}`, `第 ${refs.relationStep.step} 步的 id`)})`;
      }
      const label = resolveLocalizedString(field.label, locale);
      const required = field.required ? pick(locale, ", required", ",必填") : "";
      return label || required ? `${field.key} (${label ?? field.type}${required})` : field.key;
    });
  const extras = extraDefs(ctx, type.typeKey);
  if (extras.length > 0) {
    parts.push(`extra.{${extras.map((def) => def.key).join(", ")}} (${pick(locale, "fields the owner added", "站長加的欄位")})`);
  }
  return clip(parts.join(pick(locale, ", ", "、")), MAX_FIELD_LINE_CHARS);
}

// ── 各段 ─────────────────────────────────────────────────────────────────────

function orientation(ctx: GuideContext, canChange: boolean): string[] {
  const { locale, tool } = ctx;
  // 佔位字不能直接交給 tool 名的轉換(wire 名會把 < > 也換掉):先用一個合法的字頂著。
  const pattern = (verb: string) => tool(`content.TYPE.${verb}`).replace("TYPE", "<type>");
  const change = canChange ? pick(locale, ", create / update / delete to change", ",create / update / delete 修改") : "";
  const lines = [
    pick(locale, "## How this back office works", "## 後台怎麼運作"),
    pick(
      locale,
      `- Content (products, posts, pages…) is split into content types. Each type has its own tools: ${pattern("list")} and ${pattern("get")} to find and read${change}. To find something by its text, use ${tool("core.content.search")}.`,
      `- 內容(商品、文章、頁面…)分成不同的內容類型,每種都有自己的工具:${pattern("list")}、${pattern("get")} 查詢${change}。用文字找東西時用 ${tool("core.content.search")}。`,
    ),
    pick(
      locale,
      '- New entries are drafts. Set status to "published" to put one on the site.',
      '- 新建立的內容是草稿。status 設成 "published" 才會出現在網站上。',
    ),
  ];
  if (ctx.has("core.media.upload")) {
    lines.push(
      pick(
        locale,
        `- Pictures live in the media library. An image field stores a media key such as core/2026/09/abc123.jpg, never a URL: add a picture with ${tool("core.media.upload")} (give it a link to the image file) and put the key it returns into the field. To reuse a picture that is already there, find it with ${tool("core.media.list")}.`,
        `- 圖片放在媒體庫。圖片欄位存的是媒體 key(像 core/2026/09/abc123.jpg),不是網址:用 ${tool("core.media.upload")} 上傳(給它圖片檔的連結),把回傳的 key 填進欄位。已經在媒體庫裡的圖用 ${tool("core.media.list")} 找。`,
      ),
    );
  }
  lines.push(
    pick(
      locale,
      "- A relation field (such as a product's category) takes the id of the other entry. Look the id up with that type's list tool.",
      "- 關聯欄位(例如商品的分類)填另一筆內容的 id,用那種內容的 list 工具查。",
    ),
  );
  if (Object.values(ctx.extraFields).some((defs) => defs.length > 0)) {
    lines.push(
      pick(
        locale,
        '- Fields the site owner added go under data.extra, for example { "extra": { "origin": "Taiwan" } }. Each type\'s create and update tools list them.',
        '- 站長另外加的欄位放在 data.extra 底下,例如 { "extra": { "origin": "台灣" } }。各內容類型的 create、update 工具會列出有哪些。',
      ),
    );
  }
  return lines;
}

function stockStep(ctx: GuideContext, toolNames: readonly string[], extensions: readonly AgentGuideExtension[]): string | null {
  const { locale, tool } = ctx;
  const stockTools = toolNames.filter((name) => /(^|[._])(stock|inventory)([._]|$)/.test(name));
  const withGuides = extensions.some((ext) => ext.guide !== undefined);
  const parts: string[] = [];
  if (stockTools.length > 0) {
    parts.push(pick(locale, `Stock: set it with ${stockTools.map(tool).join(", ")}.`, `庫存:用 ${stockTools.map(tool).join("、")} 設定。`));
  } else if (extensions.some((ext) => ext.id === "inventory")) {
    parts.push(
      pick(
        locale,
        "Stock: there is no tool for it here, so tell the user to set it in the admin.",
        "庫存:這裡沒有對應的工具,請使用者到後台設定。",
      ),
    );
  }
  if (withGuides) {
    parts.push(
      pick(
        locale,
        "Other per-product settings: follow the plugin notes below.",
        "其他每個商品的設定:照下面插件說明做。",
      ),
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function productRecipe(ctx: GuideContext, toolNames: readonly string[], extensions: readonly AgentGuideExtension[]): string[] {
  const product = ctx.types.get(`${CATALOG_EXT_ID}.product`);
  if (!product || !ctx.has(contentTool(product.typeKey, "create"))) return [];
  const { locale, tool } = ctx;
  const categoryKey = `${CATALOG_EXT_ID}.category`;
  const hasCategory = ctx.types.has(categoryKey) && ctx.has(contentTool(categoryKey, "list"));
  const canUpload = ctx.has("core.media.upload") && product.fields.some((f) => f.type === "media");

  const steps: string[] = [];
  const mediaStep = canUpload ? steps.length + 1 : undefined;
  if (canUpload) {
    // 商品目錄的商品只有一個圖片欄位:使用者一次給好幾張時,模型要知道只放得下一張。
    const imageFields = product.fields.filter((f) => f.type === "media").map((f) => f.key);
    const single =
      imageFields.length === 1
        ? pick(
            locale,
            ` A product has one image (${imageFields[0]}); if the user gives several photos, ask which one to use.`,
            `商品只有一張圖(${imageFields[0]});使用者給了好幾張時,先問要用哪一張。`,
          )
        : "";
    steps.push(
      pick(
        locale,
        `Photo: upload it with ${tool("core.media.upload")} { url, alt: <product name> } and keep the key it returns.${single}`,
        `照片:用 ${tool("core.media.upload")} { url, alt: <商品名稱> } 上傳,留下回傳的 key。${single}`,
      ),
    );
  }
  const relationStep = hasCategory ? { to: categoryKey, step: steps.length + 1 } : undefined;
  if (hasCategory) {
    const create = ctx.has(contentTool(categoryKey, "create"))
      ? pick(locale, `, and ask before creating it with ${tool(contentTool(categoryKey, "create"))}`, `,要新增時先問使用者,再用 ${tool(contentTool(categoryKey, "create"))}`)
      : "";
    steps.push(
      pick(
        locale,
        `Category: find its id with ${tool(contentTool(categoryKey, "list"))}. If it does not exist, say so${create}.`,
        `分類:用 ${tool(contentTool(categoryKey, "list"))} 找到它的 id。沒有這個分類就說出來${create}。`,
      ),
    );
  }
  steps.push(
    pick(
      locale,
      `Create the product with ${tool(contentTool(product.typeKey, "create"))}. data: ${fieldLine(ctx, product, { mediaStep, relationStep })}. It starts as a draft.`,
      `用 ${tool(contentTool(product.typeKey, "create"))} 建立商品。data:${fieldLine(ctx, product, { mediaStep, relationStep })}。建立後是草稿。`,
    ),
  );
  const stock = stockStep(ctx, toolNames, extensions);
  if (stock) steps.push(stock);
  steps.push(
    pick(
      locale,
      `Publish: once the user agrees, ${tool(contentTool(product.typeKey, "update"))} { id, status: "published" }.`,
      `上架:使用者同意後,${tool(contentTool(product.typeKey, "update"))} { id, status: "published" }。`,
    ),
    pick(
      locale,
      `Check: read it back with ${tool(contentTool(product.typeKey, "get"))} and confirm the name, price, image, category and status. Its public page is /products/<slug>.`,
      `確認:用 ${tool(contentTool(product.typeKey, "get"))} 讀回來,核對名稱、價格、圖片、分類與狀態。前台頁面是 /products/<slug>。`,
    ),
  );
  return [
    pick(locale, `### Create a complete product (${product.typeKey})`, `### 從零建立一個完整的商品(${product.typeKey})`),
    ...numbered(steps),
  ];
}

function postRecipe(ctx: GuideContext): string[] {
  const post = [...ctx.types.values()].find(
    (type) =>
      POST_TYPE_NAMES.has(type.typeKey.slice(type.typeKey.indexOf(".") + 1)) &&
      ctx.has(contentTool(type.typeKey, "create")),
  );
  if (!post) return [];
  const { locale, tool } = ctx;
  const canUpload = ctx.has("core.media.upload") && post.fields.some((f) => f.type === "media");
  const steps: string[] = [];
  if (canUpload) {
    steps.push(
      pick(
        locale,
        `Cover: upload it with ${tool("core.media.upload")} { url, alt } and keep the key it returns.`,
        `封面:用 ${tool("core.media.upload")} { url, alt } 上傳,留下回傳的 key。`,
      ),
    );
  }
  steps.push(
    pick(
      locale,
      `Create it with ${tool(contentTool(post.typeKey, "create"))}. data: ${fieldLine(ctx, post, { mediaStep: canUpload ? 1 : undefined })}. Pass status: "published" only when the user wants it live now; otherwise it stays a draft.`,
      `用 ${tool(contentTool(post.typeKey, "create"))} 建立。data:${fieldLine(ctx, post, { mediaStep: canUpload ? 1 : undefined })}。使用者要馬上發佈才帶 status: "published",否則是草稿。`,
    ),
    pick(
      locale,
      `Check: read it back with ${tool(contentTool(post.typeKey, "get"))}.`,
      `確認:用 ${tool(contentTool(post.typeKey, "get"))} 讀回來核對。`,
    ),
  );
  return [
    pick(locale, `### Publish a news post with a cover (${post.typeKey})`, `### 發佈一篇有封面的消息(${post.typeKey})`),
    ...numbered(steps),
  ];
}

function orderRecipe(ctx: GuideContext, toolNames: readonly string[]): string[] {
  const owners = toolNames
    .map((name) => /^([a-z][a-z0-9_]*)\.orders\.get$/.exec(name)?.[1])
    .filter((id): id is string => id !== undefined && ctx.has(`${id}.orders.list`));
  if (owners.length === 0) return [];
  const { locale, tool } = ctx;
  const get = owners.map((id) => tool(`${id}.orders.get`)).join(" / ");
  const list = owners.map((id) => tool(`${id}.orders.list`)).join(" / ");
  return [
    pick(locale, "### Look up an order", "### 查一筆訂單"),
    pick(locale, `- With an order number: ${get} { orderNo }.`, `- 有訂單編號:${get} { orderNo }。`),
    pick(
      locale,
      `- Without one: ${list} (filter by status if you know it), match the customer's name, then read that order with ${get}.`,
      `- 沒有編號:${list}(知道狀態就用 status 篩),比對客人姓名,再用 ${get} 讀那一筆。`,
    ),
    pick(
      locale,
      "- Read the order's notes before changing anything, and change its status only when the user asks.",
      "- 動手之前先看訂單上的備註;使用者要求時才改訂單狀態。",
    ),
  ];
}

function extensionSection(ctx: GuideContext, extensions: readonly AgentGuideExtension[]): string[] {
  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const ext of extensions) {
    const text = resolveLocalizedString(ext.guide, ctx.locale)?.trim();
    if (!text) continue;
    const block = `### ${ext.name}\n${clip(text, AGENT_GUIDE_MAX_CHARS)}`;
    if (used + block.length > MAX_EXTENSION_SECTION_CHARS) {
      omitted++;
      continue;
    }
    blocks.push(block);
    used += block.length;
  }
  if (blocks.length === 0 && omitted === 0) return [];
  const more =
    omitted > 0
      ? [pick(ctx.locale, `(Notes from ${omitted} more plugins were left out for length.)`, `(另有 ${omitted} 個插件的說明因篇幅省略。)`)]
      : [];
  return [pick(ctx.locale, "## From installed plugins", "## 插件說明"), ...blocks, ...more];
}

function ownerSection(locale: Locale, notes: string): string[] {
  if (!notes) return [];
  return [
    pick(locale, "## Notes from the site owner", "## 站長的說明"),
    pick(
      locale,
      "The site owner wrote these for you. Follow them for tone, naming and choices; the rules above still come first.",
      "以下是站長寫給你的。語氣、命名與各種選擇照著做;上面的規則仍然優先。",
    ),
    "",
    notes,
  ];
}

/** 組出整份說明。純函式。 */
export function buildAgentGuide(input: AgentGuideInput): string {
  const names = new Set(input.toolNames);
  const format = input.toolName ?? ((name: string) => name);
  const ctx: GuideContext = {
    locale: input.locale,
    has: (name) => names.has(name),
    tool: format,
    types: new Map(input.contentTypes.map((type) => [type.typeKey, type])),
    extraFields: input.extraFields,
  };
  const recipes = [
    productRecipe(ctx, input.toolNames, input.extensions),
    postRecipe(ctx),
    orderRecipe(ctx, input.toolNames),
  ].filter((recipe) => recipe.length > 0);

  // 只能查看的 AI 連線拿到的 tool 清單裡沒有任何 create/update/delete。
  const canChange = input.toolNames.some((name) => /^content\..+\.(create|update|delete)$/.test(name));
  const sections: string[][] = [orientation(ctx, canChange)];
  if (recipes.length > 0) {
    sections.push([
      pick(input.locale, "## How to do common jobs", "## 常見工作怎麼做"),
      pick(
        input.locale,
        "Each change below is one tool call. Do them in order and check each result before the next.",
        "下面每一個修改都是一次工具呼叫。照順序做,每一步看過結果再做下一步。",
      ),
      ...recipes.flatMap((recipe) => ["", ...recipe]),
    ]);
  }
  const plugins = extensionSection(ctx, input.extensions);
  if (plugins.length > 0) sections.push(plugins);

  const builtIn = sections.map((lines) => lines.join("\n")).join("\n\n");
  const bounded =
    builtIn.length > MAX_BUILT_IN_CHARS
      ? `${builtIn.slice(0, MAX_BUILT_IN_CHARS)}\n…[guide truncated]`
      : builtIn;
  const owner = ownerSection(input.locale, input.ownerNotes);
  return owner.length > 0 ? `${bounded}\n\n${owner.join("\n")}` : bounded;
}

// ── 載入 ─────────────────────────────────────────────────────────────────────

export interface LoadAgentGuideOptions {
  locale: Locale;
  toolNames: readonly string[];
  toolName?: (name: string) => string;
  /** 呼叫端已經取好的 runtime / 型別(agent-prompt 本來就要讀),省一次。 */
  runtime?: Pick<ExtRuntime, "enabled">;
  contentTypes?: readonly AgentGuideContentType[];
}

/** 已啟用 extension → 說明要的那三欄。 */
function guideExtensions(runtime: Pick<ExtRuntime, "enabled">, locale: Locale): AgentGuideExtension[] {
  return runtime.enabled.map((ext) => ({
    id: ext.id,
    name: resolveLocalizedString(ext.name, locale) ?? ext.id,
    ...(ext.agentGuide !== undefined ? { guide: ext.agentGuide } : {}),
  }));
}

/** 讀當下站台狀態,組出說明。 */
export async function loadAgentGuide(options: LoadAgentGuideOptions): Promise<string> {
  const { locale } = options;
  const [runtime, contentTypes, extraFields, notes] = await Promise.all([
    options.runtime ?? import("./loader").then(({ getExtRuntime }) => getExtRuntime()),
    options.contentTypes ??
      listDeclarativeTypes(locale).then((types) =>
        types.map((t) => ({
          typeKey: t.typeKey,
          label: t.typeLabel,
          fields: t.contentType.fields,
        })),
      ),
    getExtraFieldsSetting(),
    getPlainSetting<unknown>(AI_NOTES_SETTING, ""),
  ]);
  return buildAgentGuide({
    locale,
    contentTypes,
    toolNames: options.toolNames,
    extensions: guideExtensions(runtime, locale),
    extraFields,
    ownerNotes: normalizeAiNotes(notes),
    ...(options.toolName ? { toolName: options.toolName } : {}),
  });
}
