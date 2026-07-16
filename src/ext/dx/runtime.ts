import { CoreContentProvider } from "./content-provider";
import type {
  ContentBlockDef,
  ContentLeafFieldDef,
  ContentProvider,
  ContentTypeDef,
} from "../capabilities";
import type {
  DeclarativeBlockDef,
  DeclarativeContentType,
  DeclarativeLeafField,
} from "./manifest";
import { resolveLocalizedString } from "@/lib/i18n/localized";

// ContentTypeDef / ContentLeafFieldDef 的 label(capabilities.ts,禁區,型別為
// string)只是 provider 內部 metadata,不面向使用者(使用者可見 label 一律經 view 端
// fieldLabel/resolveLocalizedString 依當次 locale resolve)。label 由 v1.17.0 起可為
// LocalizedString,故在此把它壓成單一 canonical 字串(取 en/任一鍵)——locale-agnostic、
// memo-safe,不改動禁區型別。 */
const canonicalLabel = (v: DeclarativeLeafField["label"]): string | undefined =>
  resolveLocalizedString(v, "en");

// generic views(server components)在 ext API request 之外執行,拿不到 ctx.services。
// 提供一個輕量 helper 直接取得 active content provider,並綁上當次 request 的 HookBus。
// v1 未做 provider 選擇(active id 覆寫)於 view 端 —— view 一律用 core provider,
// 與 CRUD route(走 ctx.services.providers.get)語意一致(core 為 content 的 FALLBACK/預設)。

export async function getContentProvider(): Promise<ContentProvider> {
  // lazy import loader —— 斷開 module-init 循環(registry → gallery-enhance → runtime
  // → loader → registry 的 TDZ:#20)。top-level import loader 會在 registry 初始化途中
  // 把 loader 拉進求值鏈,其 top-level assertUniqueIds IIFE 存取尚未 init 的 registry。
  // dynamic import 延到呼叫期(loader 屆時由別處 import、registry 已 init),模組並 cached。
  const { getExtRuntime } = await import("../loader");
  const rt = await getExtRuntime();
  return new CoreContentProvider(rt.hooks);
}

/** leaf 子欄位 def(group/repeater/blocks nested)→ ContentLeafFieldDef。純資料映射。 */
function toLeafDef(f: DeclarativeLeafField): ContentLeafFieldDef {
  return {
    key: f.key,
    type: f.type,
    label: canonicalLabel(f.label),
    required: f.required,
    options: f.options,
    to: f.to, // 08 §1:relation/relations 目標 type key(其餘型別為 undefined)
  };
}

/** blocks 的具名 block def → ContentBlockDef(含 leaf 子欄位映射)。 */
function toBlockDef(b: DeclarativeBlockDef): ContentBlockDef {
  return {
    name: b.name,
    label: canonicalLabel(b.label),
    fields: b.fields.map(toLeafDef),
  };
}

/** manifest 的 contentType(local name)→ 完整 type key 與 ContentTypeDef。 */
export function toTypeDef(
  extId: string,
  ct: DeclarativeContentType,
): ContentTypeDef {
  return {
    type: `${extId}.${ct.name}`,
    label: canonicalLabel(ct.label),
    slugField: ct.slugField,
    fields: ct.fields.map((f) => ({
      key: f.key,
      type: f.type,
      label: canonicalLabel(f.label),
      required: f.required,
      options: f.options,
      to: f.to, // 08 §1:relation/relations 目標 type key(其餘型別為 undefined)
      // Tier 2 v1.2:結構欄位的 nested defs（其餘型別為 undefined）。
      fields: f.fields?.map(toLeafDef),
      blocks: f.blocks?.map(toBlockDef),
      max: f.max,
    })),
  };
}
