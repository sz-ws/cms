import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SlotRegistry, defineSlot, fill, type SlotSource } from "../src/ext/slots";

// 畫面上的插槽(src/components/Slot.tsx、SlotRegion.tsx):伺服器元件裡用 <Slot>,client 元件裡用
// slotParts() + <SlotRegion>,兩條路畫出來的要一樣。

// loader 整包換掉:這裡只要「當次請求的 runtime 有哪些 fills」。
const runtime = vi.hoisted(() => ({ slots: null as unknown }));
vi.mock("@/ext/loader", () => ({ getExtRuntime: async () => ({ slots: runtime.slots }) }));

import { Slot, slotParts } from "../src/components/Slot";
import { SlotFillBoundary } from "../src/components/SlotFillBoundary";
import { SlotRegion } from "../src/components/SlotRegion";

const Panel = defineSlot<{ title: string }>("test.panel");

const tag = (name: string) =>
  function Tag({ title }: { title: string }) {
    return <i>{name}:{title}</i>;
  };

const frame = (name: string) =>
  function Frame({ children }: { title: string; children: ReactNode }) {
    return <section data-frame={name}>{children}</section>;
  };

const fallback = <p>default</p>;

/** 伺服器那條路。 */
async function viaSlot(sources: SlotSource[]): Promise<string> {
  runtime.slots = new SlotRegistry(sources);
  return renderToStaticMarkup(await Slot({ of: Panel, title: "T", children: fallback }));
}

/** client 元件那條路。 */
async function viaRegion(sources: SlotSource[]): Promise<string> {
  runtime.slots = new SlotRegistry(sources);
  const parts = await slotParts(Panel, { title: "T" });
  return renderToStaticMarkup(<SlotRegion parts={parts}>{fallback}</SlotRegion>);
}

const CASES: { name: string; sources: SlotSource[]; html: string }[] = [
  { name: "沒有人填:只畫預設內容", sources: [], html: "<p>default</p>" },
  {
    name: "前面與後面夾著預設內容,照層的先後",
    sources: [
      { extId: "site", layer: "site", fills: [fill(Panel, { before: tag("site") }), fill(Panel, { after: tag("site-after") })] },
      { extId: "plugin", fills: [fill(Panel, { before: tag("plugin") })] },
    ],
    html: "<i>plugin:T</i><i>site:T</i><p>default</p><i>site-after:T</i>",
  },
  {
    name: "換掉:預設內容不畫,前後照舊",
    sources: [
      { extId: "plugin", fills: [fill(Panel, { before: tag("before") }), fill(Panel, { replace: tag("plugin") })] },
      { extId: "site", layer: "site", fills: [fill(Panel, { replace: tag("site") })] },
    ],
    html: "<i>before:T</i><i>site:T</i>",
  },
  {
    name: "包起來:整塊由裡到外,站台在最外面",
    sources: [
      { extId: "site", layer: "site", fills: [fill(Panel, { wrap: frame("site") })] },
      { extId: "plugin", fills: [fill(Panel, { wrap: frame("plugin") }), fill(Panel, { after: tag("after") })] },
    ],
    html: '<section data-frame="site"><section data-frame="plugin"><p>default</p><i>after:T</i></section></section>',
  },
];

describe("畫面上的插槽", () => {
  for (const { name, sources, html } of CASES) {
    it(`${name}(伺服器元件)`, async () => {
      expect(await viaSlot(sources)).toBe(html);
    });
    it(`${name}(client 元件)`, async () => {
      expect(await viaRegion(sources)).toBe(html);
    });
  }

  it("client 元件沒有拿到 parts 就只畫預設內容", () => {
    expect(renderToStaticMarkup(<SlotRegion>{fallback}</SlotRegion>)).toBe("<p>default</p>");
  });

  it("交給 client 元件的 wrap 是元件本身與它的 props,不是先畫好的 element", async () => {
    const Frame = frame("site");
    runtime.slots = new SlotRegistry([{ extId: "site", layer: "site", fills: [fill(Panel, { wrap: Frame })] }]);
    const parts = await slotParts(Panel, { title: "T" });
    expect(parts.slot).toBe("test.panel");
    expect(parts.wrap).toEqual([Frame]);
    expect(parts.props).toEqual({ title: "T" });
  });
});

// 一個填的元件畫壞了(SlotFillBoundary):只少它一個;換掉或包起來的壞了就畫原本的內容。
// renderToStaticMarkup 沒有 error boundary,所以直接看這個元件出錯之後畫什麼。
describe("填的元件畫壞了", () => {
  const failed = (props: { slot: string; fallback?: ReactNode; children?: ReactNode }) => {
    const boundary = new SlotFillBoundary(props);
    boundary.state = SlotFillBoundary.getDerivedStateFromError();
    return boundary.render();
  };

  it("沒出錯時原樣畫", () => {
    expect(renderToStaticMarkup(<SlotFillBoundary slot="test.panel"><i>ok</i></SlotFillBoundary>)).toBe("<i>ok</i>");
  });

  it("前後的元件壞了:不畫它", () => {
    expect(failed({ slot: "test.panel", children: <i>broken</i> })).toBeNull();
  });

  it("換掉或包起來的元件壞了:畫原本的內容", () => {
    expect(failed({ slot: "test.panel", fallback, children: <i>broken</i> })).toBe(fallback);
  });
});
