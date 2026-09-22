import type { ComponentType } from "react";
import { and, eq } from "drizzle-orm";
import { getSetting } from "@/lib/settings";
import { db } from "@/lib/db";
import { declarativeExtensions as dxTable } from "@/lib/schema";
import { cachedPublicQuery } from "./content-cache";
import { parseManifest, type DeclarativeManifest } from "./manifest";
import { isSubmissionTypeName } from "./submission";
import { pickTitleField } from "./views/field-utils";
import {
  allScriptRefs,
  capScriptData,
  CONTENT_REF_LIMIT,
  hashScripts,
  renderInlineScript,
  renderScriptSrc,
  type DeclarativeScript,
  type ScriptRef,
  type ScriptsApproval,
} from "./scripts";

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

export function makeScriptsWidget(
  extId: string,
  manifest: DeclarativeManifest,
  approval: ScriptsApproval,
): ComponentType {
  const scripts: readonly DeclarativeScript[] = manifest.scripts ?? [];
  const defaults = Object.fromEntries(
    (manifest.settings ?? []).map((field) => [field.key, field.default]),
  );

  async function DeclarativeScripts() {
    if ((await hashScripts(scripts)) !== approval.hash) return null;

    const refs = allScriptRefs(scripts);
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

    return (
      <>
        {scripts.map((script, i) => {
          if (script.src !== undefined) {
            const src = renderScriptSrc(script.src, settings);
            return src ? <script key={i} async src={src} data-ext={extId} /> : null;
          }
          return (
            <script
              key={i}
              data-ext={extId}
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
