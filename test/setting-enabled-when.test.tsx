import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 用不到的設定反灰(1.67.0 SettingField.enabledWhen):欄位照樣在畫面上,但不能改;
// 換到用得到的選項就恢復。AI 卡是第一個用的:Workers AI 不需要 API 網址與金鑰。

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { getMessages } from "@/lib/i18n/index";
import { SettingsWorkspace } from "@/components/admin/SettingsWorkspace";
import { CORE_SETTINGS } from "@/lib/settings";

const AI_KEYS = ["core.ai.mode", "core.ai.baseUrl", "core.ai.apiKey", "core.ai.model"];
const aiFields = CORE_SETTINGS.filter((f) => AI_KEYS.includes(f.key));

function renderAi(mode: string) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale: "zh-Hant", messages: getMessages("zh-Hant") },
      createElement(SettingsWorkspace, {
        sections: [{ id: "core-ai", title: "AI", keyPrefix: "", fields: aiFields }],
        values: { "core.ai.mode": mode },
        initialTab: "core",
      }),
    ),
  );
}

/** 畫面上不能改的文字輸入框是哪幾個設定。 */
function disabledInputs(html: string): string[] {
  return ["core.ai.baseUrl", "core.ai.apiKey", "core.ai.model"].filter((key) => {
    const label = html.match(new RegExp(`<label[^>]*for="([^"]+)"[^>]*>${labelOf(key)}`))?.[1];
    const input = html.match(new RegExp(`<input[^>]*id="${label}"[^>]*>`))?.[0] ?? "";
    return /\sdisabled=""/.test(input);
  });
}

function labelOf(key: string): string {
  const label = aiFields.find((f) => f.key === key)?.label;
  return typeof label === "string" ? label : (label?.["zh-Hant"] ?? "");
}

describe("AI 設定:用不到的欄位反灰", () => {
  it("選 Workers AI:API 網址與金鑰不能填,模型可以", () => {
    expect(disabledInputs(renderAi("workers-ai"))).toEqual(["core.ai.baseUrl", "core.ai.apiKey"]);
  });

  it("關閉:三個都不能填", () => {
    expect(disabledInputs(renderAi("off"))).toEqual(["core.ai.baseUrl", "core.ai.apiKey", "core.ai.model"]);
  });

  it("OpenAI 相容、Anthropic 相容:三個都可以填", () => {
    expect(disabledInputs(renderAi("openai"))).toEqual([]);
    expect(disabledInputs(renderAi("anthropic"))).toEqual([]);
  });

  it("反灰的欄位還在畫面上(不是藏起來)", () => {
    const html = renderAi("workers-ai");
    for (const key of ["core.ai.baseUrl", "core.ai.apiKey", "core.ai.model"]) {
      expect(html).toContain(labelOf(key));
    }
  });

  it("enabledWhen 指到的欄位存在,列的值都是它的選項", () => {
    const mode = aiFields.find((f) => f.key === "core.ai.mode");
    const options = mode?.type === "select" ? mode.options.map((o) => o.value) : [];
    for (const field of CORE_SETTINGS) {
      if (!field.enabledWhen) continue;
      expect(field.enabledWhen.key).toBe("core.ai.mode");
      expect(field.enabledWhen.oneOf.every((value) => options.includes(String(value)))).toBe(true);
    }
  });
});
