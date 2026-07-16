// manifest `requires[]`(服務需求)的滿足判定。
//
// 與 features.ts(core 版本功能表,靜態清單)刻意分檔分軸:這裡問的是「provider
// registry 目前有沒有人提供這個 capability」—— 可能是 core 內建(upload/content/
// email:send),也可能要先安裝提供該服務的 code extension(如 cron:tick)。
// availableServices() 與 services.ts 用同一個 buildProviderRegistry(),code extension
// 的 `provides` 接上 registry 時這裡自動一起生效。

import type { LocalizedString } from "@/lib/i18n/localized";

export interface ServiceRequirement {
  capability: string;
  optional?: boolean;
  // spec-extension-i18n.md §1 #17:reason 可為 LocalizedString(union)。此判定只讀
  // capability/optional,不觸 reason;Browse chips 的 reason 顯示(surface B)v1 未接線。
  reason?: LocalizedString;
}

/** 目前有註冊者的 provider capability 全集(含 enabled code extension 的 provides)。 */
export async function availableServices(): Promise<string[]> {
  // loader 與 services 皆走 dynamic import:兩者相依鏈含 next/navigation,靜態 import
  // 會拖垮 workers test pool(同 type-directory.ts 的教訓)。本檔的純函式
  // (unmetRequiredServices)須可被測試直接靜態載入,故接線邏輯全數延後至呼叫時。
  const { getExtRuntime } = await import("./loader");
  const { buildProviderRegistry } = await import("./services");
  const rt = await getExtRuntime();
  return buildProviderRegistry(rt).capabilities();
}

/**
 * requires 中「非 optional 且目前無人提供」的 capability(去重、依宣告順序)。
 * 空陣列 = 可安裝(optional 缺席不擋,由 UI 顯示建議)。
 */
export function unmetRequiredServices(
  requires: readonly ServiceRequirement[] | undefined,
  available: readonly string[],
): string[] {
  if (!requires || requires.length === 0) return [];
  const availableSet = new Set(available);
  const unmet: string[] = [];
  const seen = new Set<string>();
  for (const req of requires) {
    if (req.optional) continue;
    if (availableSet.has(req.capability)) continue;
    if (seen.has(req.capability)) continue;
    seen.add(req.capability);
    unmet.push(req.capability);
  }
  return unmet;
}
