export function settingControlId(fullKey: string): string {
  return `setting-${fullKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

// ---- Setting group registry(settings 頁「一個 group 一張卡」的唯一真相)----
//
// 卡片不再由 page.tsx 的硬編碼清單決定:哪些卡存在,完全從欄位定義的
// SettingField.group 推導(有欄位的 group 才長卡,空 group 自動消失)。
// 這張表只補「排序 + 文案」這兩件無法從欄位推導的事:
//   - order:卡片順序的唯一來源(升冪;Object key 順序永遠不參與決策)。
//   - title / description:英文字面值,i18n 有對應 key 時由 key 覆蓋。
//
// 新增一個 group:在對應 setting 上寫 group: "<id>" 即可長出卡片(page.tsx
// 不必改)。想控制它的位置與文案,就在 SETTING_GROUPS 補一列;沒補也只是
// 落到最後、標題用 id 推導的字。

/** 沒宣告 group 的欄位落腳處(與舊行為一致)。 */
export const DEFAULT_SETTING_GROUP = "general";

export interface SettingGroup {
  /** 對應 SettingField.group。 */
  id: string;
  /** 卡片順序(升冪)。刻意留 10 的間隔,之後插隊不必重編全表。 */
  order: number;
  /** 英文字面值;i18n 有 `settings.group.<id>` 時以它為準。 */
  title: string;
  /** 英文字面值;i18n 有 `settings.group.<id>Desc` 時以它為準。 */
  description: string;
}

export const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    id: "general",
    order: 10,
    title: "General",
    description: "Site identity and admin locale.",
  },
  {
    id: "seo",
    order: 20,
    title: "SEO",
    description: "robots.txt, sitemap.xml, and the RSS feed.",
  },
  {
    id: "email",
    order: 30,
    title: "Email",
    description: "Outgoing mail provider and sender address.",
  },
  {
    id: "ai",
    order: 40,
    title: "AI",
    description: "Provider, model, and credentials for the ai:generate capability.",
  },
  {
    id: "advanced",
    order: 90,
    title: "Advanced",
    description: "Secrets and platform internals.",
  },
];

/** 未登記的 group id → 可讀標題("media-library" → "Media library")。 */
function titleizeGroupId(id: string): string {
  const words = id.split(/[-_.\s]+/).filter(Boolean);
  if (words.length === 0) return id;
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/**
 * 取 group metadata。未登記的 group 不會被丟掉——它拿到一個推導出來的標題,
 * 並排在所有已登記 group 之後(彼此再依欄位宣告順序,見 groupSettingFields)。
 */
export function settingGroupMeta(id: string): SettingGroup {
  const known = SETTING_GROUPS.find((g) => g.id === id);
  if (known) return known;
  return {
    id,
    order: Number.MAX_SAFE_INTEGER,
    title: titleizeGroupId(id),
    description: "",
  };
}

/** i18n key 慣例:`settings.group.<id>` / `settings.group.<id>Desc`。 */
export function settingGroupTitleKey(id: string): string {
  return `settings.group.${id}`;
}
export function settingGroupDescriptionKey(id: string): string {
  return `settings.group.${id}Desc`;
}

export interface SettingFieldGroup<F> {
  /** group id(= SettingField.group;沒宣告的落在 DEFAULT_SETTING_GROUP)。 */
  id: string;
  title: string;
  /** 沒有說明文字時為空字串(呼叫端自行決定不渲染)。 */
  description: string;
  fields: F[];
}

type MessageLookup = Readonly<Record<string, string | undefined>>;

/**
 * 依欄位自己宣告的 group 分堆,回傳「有欄位的 group」的有序清單。
 *
 * 順序是決定性的:先比 SETTING_GROUPS 的 order,同 order(含兩個都未登記)
 * 再比該 group 第一個欄位在 fields 陣列裡的位置。全程不依賴 Object key 順序。
 *
 * `messages` 給了就用 i18n 覆蓋標題/說明(缺 key 時退回表裡的英文字面值),
 * 沒給就純英文——server component 傳 getMessages(locale) 進來即可。
 */
export function groupSettingFields<F extends { group?: string }>(
  fields: readonly F[],
  messages?: MessageLookup,
): SettingFieldGroup<F>[] {
  const buckets = new Map<string, F[]>();
  const firstSeen = new Map<string, number>();
  for (const field of fields) {
    const id = field.group ?? DEFAULT_SETTING_GROUP;
    const bucket = buckets.get(id);
    if (bucket) {
      bucket.push(field);
    } else {
      buckets.set(id, [field]);
      firstSeen.set(id, firstSeen.size);
    }
  }

  return [...buckets.entries()]
    .map(([id, groupFields]) => ({
      meta: settingGroupMeta(id),
      seen: firstSeen.get(id) ?? 0,
      fields: groupFields,
    }))
    .sort((a, b) => a.meta.order - b.meta.order || a.seen - b.seen)
    .map(({ meta, fields: groupFields }) => ({
      id: meta.id,
      title: messages?.[settingGroupTitleKey(meta.id)] ?? meta.title,
      description:
        messages?.[settingGroupDescriptionKey(meta.id)] ?? meta.description,
      fields: groupFields,
    }));
}
