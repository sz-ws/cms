import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusMultiFilter } from "@/components/admin/StatusMultiFilter";

// 1.56.0:列表的狀態篩選可以勾好幾個 —— 「全部」在沒勾任何狀態時亮著,每個狀態是一格 checkbox。

describe("StatusMultiFilter", () => {
  const options = [
    { value: "published", label: "已發布", count: 3 },
    { value: "draft", label: "草稿" },
  ];

  it("lights up All when nothing is ticked", () => {
    const html = renderToStaticMarkup(
      createElement(StatusMultiFilter, {
        label: "狀態",
        allLabel: "全部",
        options,
        selected: [],
        onChange: () => {},
      }),
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="狀態"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>全部/);
    expect(html.match(/aria-checked="false"/g)).toHaveLength(2);
    expect(html).toContain(">3<");
  });

  it("marks every ticked status", () => {
    const html = renderToStaticMarkup(
      createElement(StatusMultiFilter, {
        label: "狀態",
        allLabel: "全部",
        options,
        selected: ["published", "draft"],
        onChange: () => {},
      }),
    );
    expect(html).toMatch(/aria-pressed="false"[^>]*>全部/);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(2);
  });
});
