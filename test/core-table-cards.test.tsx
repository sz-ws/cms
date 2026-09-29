import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoreTable, type CoreColumn } from "../src/components/admin/core-table";

// 1.64.0 CoreTable cards:640px 以下一列一張卡片。兩份都畫,CSS 決定顯示哪一份。

type Row = { id: string; name: string; note: string | null; done: boolean };
const rows: Row[] = [
  { id: "a", name: "第一筆", note: "有備註", done: false },
  { id: "b", name: "第二筆", note: null, done: true },
];
const columns: CoreColumn<Row>[] = [
  { key: "name", label: "名稱", render: (r) => r.name },
  { key: "note", label: "備註", render: (r) => r.note },
];

const render = (cards?: Parameters<typeof CoreTable<Row>>[0]["cards"]) =>
  renderToStaticMarkup(createElement(CoreTable<Row>, { columns, rows, rowKey: (r) => r.id, cards }));
const cardsOf = (html: string) => html.split("<li ").slice(1);

describe("CoreTable cards", () => {
  it("without cards draws only the table, which scrolls sideways on phones", () => {
    const html = render();
    expect(html).not.toContain("data-row-cards");
    expect(html).not.toContain("max-sm:hidden");
  });

  it("hides the table below 640px and adds one card per row", () => {
    const html = render({ label: "清單", title: (r) => r.name, fields: columns });
    expect(html).toMatch(/<div class="overflow-x-auto[^"]* max-sm:hidden"><table/);
    expect(html).toContain('<ul aria-label="清單" data-row-cards="" class="flex flex-col gap-2.5 sm:hidden">');
    expect(cardsOf(html)).toHaveLength(2);
  });

  it("leaves out fields whose value is empty", () => {
    const [first, second] = cardsOf(render({ title: (r) => r.name, fields: columns }));
    expect(first).toContain("<dt");
    expect(first).toContain("有備註");
    expect(second).not.toContain("備註");
  });

  it("draws the badge, the action with its screen-reader note, and the extra link", () => {
    const html = render({
      title: (r) => r.name,
      badge: (r) => (r.done ? "完成" : "進行中"),
      fields: [],
      action: (r) => (r.done ? null : { text: "處理", about: r.name, primary: true, onClick: () => {} }),
      extra: (r) => createElement("a", { href: `/x/${r.id}` }, "連結"),
    });
    const [first, second] = cardsOf(html);
    expect(first).toContain("進行中");
    expect(first).toMatch(/<button type="button" class="[^"]*after:absolute after:inset-0 bg-black[^"]*">處理<span class="sr-only"> 第一筆<\/span><\/button>/);
    expect(first).toContain('<div class="relative z-10"><a href="/x/a">連結</a></div>');
    expect(second).toContain("完成");
    expect(second).not.toContain("<button");
  });

  it("writes no screen-reader note when the action has no about", () => {
    const html = render({ title: (r) => r.name, fields: [], action: () => ({ text: "查看", onClick: () => {} }) });
    expect(html).not.toContain("sr-only");
  });
});
