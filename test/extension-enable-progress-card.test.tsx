import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 套用更新後的進度卡:店主看到的是「更新資料表」,不是 0002_xxx 這種 migration id。

vi.mock("@/lib/i18n/I18nProvider", async () => {
  const { getMessages, format } = await import("../src/lib/i18n/index");
  const zh = getMessages("zh-Hant");
  return {
    useT: () => (key: keyof typeof zh, params?: Record<string, string | number>) => format(zh[key], params),
  };
});

import { EnableProgressCard, type EnableProgressState } from "../src/app/(admin)/admin/extensions/EnableProgress";

const base: Omit<EnableProgressState, "steps" | "outcome"> = {
  extId: "reviews",
  name: "商品評論",
  upgrade: { from: "0.1.0", to: "0.1.1" },
};

const render = (state: EnableProgressState) =>
  renderToStaticMarkup(createElement(EnableProgressCard, { state, onClose: () => {} }));

describe("EnableProgressCard", () => {
  it("完成:兩個 migration 畫成一列「更新資料表」,不出現 migration id", () => {
    const html = render({
      ...base,
      outcome: "done",
      steps: [
        { key: "check", status: "done" },
        { key: "migrate:0001_reviews", status: "done", migration: "0001_reviews" },
        { key: "migrate:0002_reviews_replies", status: "done", migration: "0002_reviews_replies" },
        { key: "settings", status: "done", count: 0 },
        { key: "record", status: "done" },
      ],
    });
    expect(html).toContain("「商品評論」已更新到 0.1.1");
    expect(html).not.toContain("0001_reviews");
    expect(html).not.toContain("0002_reviews_replies");
    expect(html.match(/更新資料表/g)).toHaveLength(1);
    expect(html.match(/<li/g)).toHaveLength(4);
  });

  it("失敗:標題說卡在「更新資料表」", () => {
    const html = render({
      ...base,
      outcome: "failed",
      error: "資料表更新失敗",
      steps: [
        { key: "check", status: "done" },
        { key: "migrate:0002_reviews_replies", status: "failed", migration: "0002_reviews_replies" },
        { key: "settings", status: "waiting" },
        { key: "record", status: "waiting" },
      ],
    });
    expect(html).toContain("「商品評論」卡在「更新資料表」這一步");
    expect(html).not.toContain("0002_reviews_replies");
  });
});
