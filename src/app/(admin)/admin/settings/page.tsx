import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { settings } from "@/lib/schema";
import { CORE_SETTINGS, maskSecrets, getRegistryTokenMap } from "@/lib/settings";
import { groupSettingFields } from "@/lib/settings-ui";
import { getExtRuntime } from "@/ext/loader";
import {
  SettingsWorkspace,
  type SettingsSection,
} from "@/components/admin/SettingsWorkspace";
import { RegistrySourcesManager, type RegistrySource } from "@/components/admin/RegistrySourcesManager";
import { ApiTokensManager } from "@/components/admin/ApiTokensManager";
import { listApiTokens } from "@/lib/api-token";
// named import 讓打包只留 version 欄位(同 AdminSidebar 曾用的手法)。
import { version } from "../../../../../package.json";

export const dynamic = "force-dynamic";

// 05 §4:Core settings 表單 + 每個 enabled extension 一個 section。
// 這頁不是 declarative dx/views surface；它是平台自己的 settings shell，
// 所以直接吃 login page 的 Paper & Ink 語言。
export default async function SettingsPage() {
  await requireAuth("admin");

  const locale = await getLocale();
  const m = getMessages(locale);

  // 讀全表 → 組 initial values(明文 JSON.parse),再對 secret key 遮罩。
  const rows = await db().select().from(settings);
  const raw: Record<string, unknown> = {};
  for (const r of rows) raw[r.key] = JSON.parse(r.value);
  const values = await maskSecrets(raw);

  const rt = await getExtRuntime();
  const extSections = rt.enabled.filter((e) => (e.settings ?? []).length > 0);

  // Registry sources now have a dedicated manager above, so keep them out
  // of the generic settings form to avoid duplicate UI and object-array
  // values falling through the textarea renderer. registryTokens 由 manager
  // 間接寫入(PUT 時 server 端拆分),不在表單顯示。
  const coreFields = CORE_SETTINGS.filter(
    (field) =>
      field.key !== "core.registrySources" &&
      field.key !== "core.registryTokens" &&
      field.key !== "core.dashboard.insights",
  );

  // Core 卡片完全由 SettingField.group 推導(見 settings-ui.ts):有欄位的 group
  // 才長卡,順序由 SETTING_GROUPS 的 order 決定,標題/說明優先取 i18n 的
  // settings.group.<id> / settings.group.<id>Desc,缺 key 時退回表裡的英文字面值。
  // 新增一個帶新 group 的 core setting 不需要動這一頁。
  const coreGroups = groupSettingFields(coreFields, m);

  const sections: SettingsSection[] = [
    ...coreGroups.map(({ id, title, description, fields }) => ({
      id: `core-${id}`,
      title,
      description,
      fields,
      keyPrefix: "",
    })),
    ...extSections.map((ext) => ({
      id: ext.id,
      // §1 #1:extension section 標題可 localize(ext.name = LocalizedString)。
      title: resolveLocalizedString(ext.name, locale) ?? ext.id,
      description: m["settings.extensionsDesc"],
      fields: ext.settings ?? [],
      keyPrefix: `ext.${ext.id}.`,
    })),
  ];

  // Parse registry sources from settings. Back-compat: old installs stored a
  // plain string[]; the new manager stores RegistrySource[] objects.
  // Token 絕不下發 client:只給 hasToken 旗標(token 本體在 core.registryTokens,
  // AES-GCM;過渡期舊資料的 inline token 在此 strip 掉、只留旗標)。
  const tokenMap = await getRegistryTokenMap();
  const registrySourcesRaw = raw["core.registrySources"];
  const registrySources: RegistrySource[] = Array.isArray(registrySourcesRaw)
    ? registrySourcesRaw.flatMap((item) => {
        if (typeof item === "string") {
          return [{ url: item, hasToken: Boolean(tokenMap[item]) }];
        }
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { url?: unknown }).url === "string"
        ) {
          const src = item as { url: string; name?: unknown; icon?: unknown; token?: unknown };
          return [{
            url: src.url,
            name: typeof src.name === "string" ? src.name : undefined,
            icon: typeof src.icon === "string" ? src.icon : undefined,
            hasToken: Boolean(
              tokenMap[src.url] ??
                (typeof src.token === "string" && src.token.length > 0),
            ),
          }];
        }
        return [];
      })
    : [];

  if (registrySources.length === 0) {
    registrySources.push({ url: "https://raw.githubusercontent.com/sz-ws/registry/main" });
  }

  // roadmap #1 §5:API tokens 列表(永不含 raw / hash;只給 prefix / scope / 時間)。
  const apiTokens = await listApiTokens();

  return (
    <div className="relative flex flex-col gap-6 pb-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/90">
          {m["settings.title"]}
        </h1>
        <p className="text-[13px] leading-relaxed text-black/40">
          {m["settings.subtitle"]}
        </p>
      </div>

      <SettingsWorkspace
        sections={sections}
        values={values}
        coreAddon={
          <>
            <RegistrySourcesManager initialSources={registrySources} />
            <ApiTokensManager initialTokens={apiTokens} />
          </>
        }
      />

      {/* About 標記:版本/作者的正統棲身處 —— 設定頁最底,安靜但找得到
          (sidebar 常駐 chrome 太吵,已搬離)。 */}
      <p className="pt-2 text-center text-[11px] tracking-[0.02em] text-black/25">
        sz.ws CMS v{version} · crafted by{" "}
        <a
          href="https://okuso.uk"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-black/35 underline decoration-black/15 underline-offset-2 transition-colors hover:text-black/60 hover:decoration-black/35"
        >
          @kuosuko
        </a>
      </p>
    </div>
  );
}
