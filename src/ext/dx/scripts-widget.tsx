import type { ComponentType } from "react";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { getSetting } from "@/lib/settings";
import { db } from "@/lib/db";
import { declarativeExtensions as dxTable } from "@/lib/schema";
import { getLocale } from "@/lib/i18n/server";
import { cachedPublicQuery } from "./content-cache";
import { parseManifest, type DeclarativeManifest } from "./manifest";
import { isSubmissionTypeName } from "./submission";
import { pickTitleField } from "./views/field-utils";
import {
  allScriptRefs,
  capScriptData,
  CONTENT_REF_LIMIT,
  hashScripts,
  parseScriptsApproval,
  renderInlineScript,
  renderScriptSrc,
  scriptValue,
  type DeclarativeScript,
  type ScriptRef,
  type ScriptsApproval,
} from "./scripts";
import { overrideRegistry, type ScriptsSurfaceProps } from "../overrides";
import { surfaceIds } from "./surfaces";

// 1.48.0:把宣告式插件核准過的 scripts 掛上 filter:publicWidgets(interpret.tsx)。
//
// 走浮層插槽而不是另開一個:那個插槽只存在於 (public) 外框,後台永遠不會渲染到
// 這裡 —— 「只在前台」由插槽的位置保證,不用再寫一組路徑排除。
//
// 每次渲染都重算 hash 跟核准紀錄比:核准綁的是內容,不是「這個插件」。DB 裡的
// manifest 只有 install route 會寫,而它在內容變了時會要求重新核准;這裡是最後一道,
// 防的是有人直接改了 DB 列。
//
// 資料代入({{content.*}} / {{feed.*}})也在這裡:值嵌進 HTML,瀏覽器不必再打 API
// (公開的 Content API 要 bearer token,script 不能帶)。任何一個來源出錯都只是 null,
// 這個元件掛在每一條公開路由上,它的例外會變成整站 500。
//
// 1.51.0:插件的程式碼強化層可以登記 public:scripts(src/ext/overrides.ts)。登記了,
// 浮層插槽改掛那個元件,manifest 的 script 一段都不輸出、也不看核准 —— 編進網站的
// 程式碼跟程式碼插件一樣可信,核准是給「從商店來、沒人審過的程式」用的。兩條路共用
// 下面的 scriptInputsResolver:同樣的代入符號、同樣的逾時與上限、失敗同樣是 null。

const FEED_TIMEOUT_MS = 1500;

type Loaded = { id: string; slug: string | null; data: Record<string, unknown> };

async function publishedEntries(extId: string, type: string): Promise<Loaded[]> {
  const { items } = await cachedPublicQuery(extId, `${extId}.${type}`, {
    filter: { status: "published" },
    sort: { field: "createdAt", dir: "desc" },
    page: 1,
    perPage: CONTENT_REF_LIMIT,
  });
  return items.map((e) => ({ id: e.id, slug: e.slug ?? null, data: e.data }));
}

/** 別的插件的型別:只給標題,而且收件匣型別一律不給。 */
async function foreignEntries(extId: string, type: string) {
  const rows = await db()
    .select({ manifest: dxTable.manifest })
    .from(dxTable)
    .where(and(eq(dxTable.id, extId), eq(dxTable.enabled, 1)))
    .limit(1);
  if (!rows[0]) return [];
  const parsed = parseManifest(JSON.parse(rows[0].manifest));
  const ct = parsed.manifest?.contentTypes?.find((c) => c.name === type);
  if (!parsed.manifest || !ct || isSubmissionTypeName(parsed.manifest, type)) return [];
  const titleKey = pickTitleField(ct.fields, ct.slugField)?.key;
  return (await publishedEntries(extId, type)).map((e) => ({
    id: e.id,
    slug: e.slug,
    title: titleKey && typeof e.data[titleKey] === "string" ? e.data[titleKey] : null,
  }));
}

async function loadFeed(name: string): Promise<unknown> {
  const dot = name.indexOf(".");
  const { getExtRuntime } = await import("../loader");
  const feed = (await getExtRuntime()).byId(name.slice(0, dot))?.publicFeeds?.[name.slice(dot + 1)];
  if (!feed) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FEED_TIMEOUT_MS);
  });
  try {
    return await Promise.race([feed(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadData(ownId: string, ref: ScriptRef): Promise<unknown> {
  try {
    if (ref.ns === "feed") return capScriptData(await loadFeed(ref.name));
    const [head, tail] = ref.name.split(".");
    const own = tail === undefined || head === ownId;
    const data = own
      ? await publishedEntries(ownId, tail ?? head)
      : await foreignEntries(head, tail);
    return capScriptData(data);
  } catch (e) {
    console.error(`[dx:scripts] ext=${ownId} could not load {{${ref.path}}}`, e);
    return null;
  }
}

/** 一組 scripts 的代入值:設定以 key 為鍵,資料以完整路徑為鍵(renderInlineScript 的形狀)。 */
export interface ScriptInputs {
  settings: Record<string, unknown>;
  data: Record<string, unknown>;
}

/**
 * manifest → 解析它 scripts 代入值的函式。代入符號與設定預設值在這裡(interpret 期)
 * 算一次,每次渲染只讀值。scripts 與 public:scripts override 兩條路都用它。
 */
export function scriptInputsResolver(
  extId: string,
  manifest: DeclarativeManifest,
): () => Promise<ScriptInputs> {
  const refs = allScriptRefs(manifest.scripts ?? []);
  const defaults = Object.fromEntries(
    (manifest.settings ?? []).map((field) => [field.key, field.default]),
  );
  return async function resolveScriptInputs() {
    const settings: Record<string, unknown> = {};
    const data: Record<string, unknown> = {};
    await Promise.all(
      refs.map(async (ref) => {
        if (ref.ns === "settings") {
          settings[ref.name] = await getSetting(`ext.${extId}.${ref.name}`, defaults[ref.name]);
        } else {
          data[ref.path] = await loadData(extId, ref);
        }
      }),
    );
    return { settings, data };
  };
}

export function makeScriptsWidget(
  extId: string,
  manifest: DeclarativeManifest,
  approval: ScriptsApproval,
): ComponentType {
  const scripts: readonly DeclarativeScript[] = manifest.scripts ?? [];
  const resolveInputs = scriptInputsResolver(extId, manifest);

  async function DeclarativeScripts() {
    if ((await hashScripts(scripts)) !== approval.hash) return null;
    // 1.50.0:公開頁 enforce CSP(見 src/middleware.ts)。inline 靠這個請求的 nonce
    // 執行;外部 script **不**給 nonce —— 它由 policy 裡核准過的主機放行,這樣白名單
    // 才是真的在管事(給了 nonce,主機寫什麼都會被放行)。
    const nonce = (await headers()).get("x-nonce") ?? undefined;
    const { settings, data } = await resolveInputs();

    return (
      <>
        {scripts.map((script, i) => {
          if (script.src !== undefined) {
            const src = renderScriptSrc(script.src, settings);
            return src ? <script key={i} async src={src} data-ext={extId} /> : null;
          }
          return (
            // 瀏覽器解析後會把 nonce 屬性清成空字串(防止頁面讀走),hydration 比對時
            // server 的值和 DOM 對不上;script 本身已經跑過,這個差異是預期的。
            <script
              key={i}
              data-ext={extId}
              nonce={nonce}
              suppressHydrationWarning
              dangerouslySetInnerHTML={{
                __html: renderInlineScript(script.inline ?? "", settings, data),
              }}
            />
          );
        })}
      </>
    );
  }
  DeclarativeScripts.displayName = `DeclarativeScripts(${extId})`;
  return DeclarativeScripts;
}

/** 值逐一換成 inline script 看到的樣子(scriptValue)。 */
function asScriptValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, scriptValue(value)]));
}

/**
 * 1.51.0:public:scripts override 的外殼(server component)—— 解析代入值,交給登記的
 * 元件。不輸出任何 <script>、不讀 nonce:元件是 bundle 裡的程式,CSP 用不著放行什麼。
 */
function makeScriptsOverrideWidget(
  extId: string,
  manifest: DeclarativeManifest,
  Override: ComponentType<ScriptsSurfaceProps>,
): ComponentType {
  const resolveInputs = scriptInputsResolver(extId, manifest);

  async function CompiledScripts() {
    const [{ settings, data }, locale] = await Promise.all([resolveInputs(), getLocale()]);
    return (
      <Override
        extId={extId}
        settings={asScriptValues(settings)}
        data={asScriptValues(data)}
        locale={locale}
      />
    );
  }
  CompiledScripts.displayName = `CompiledScripts(${extId})`;
  return CompiledScripts;
}

/**
 * 1.51.0:這個插件要在公開頁的浮層插槽掛什麼(interpret.tsx 的 buildHooks 用)。
 *   - manifest 沒有 scripts → 不掛(override 沒有東西可以取代)。
 *   - 編進網站的程式碼登記了 public:scripts → 掛 override;不看核准。
 *   - 其他 → 1.50.0 原樣:核准過才掛 scripts,hash 對不對在渲染時比。
 */
export function publicScriptsWidget(
  extId: string,
  manifest: DeclarativeManifest,
  rawApproval: string | null | undefined,
): ComponentType | null {
  if (!manifest.scripts) return null;
  const override = overrideRegistry.get(extId, surfaceIds.publicScripts());
  if (override) {
    // 登記時已由 view "scripts" 綁定 props(overrides.ts register),這裡收斂回去不放寬。
    return makeScriptsOverrideWidget(
      extId,
      manifest,
      override as unknown as ComponentType<ScriptsSurfaceProps>,
    );
  }
  const approval = parseScriptsApproval(rawApproval);
  return approval ? makeScriptsWidget(extId, manifest, approval) : null;
}
