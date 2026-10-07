import { afterEach, describe, it, expect, vi } from "vitest";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
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
  return renderToStaticMarkup(await Slot({ of: Panel, props: { title: "T" }, children: fallback }));
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

// 填的元件在伺服器上壞了(讀資料失敗之類):當場接住,只少它一個;換掉或包起來的壞了就畫原本的內容。
// 整頁照樣由伺服器畫完,不用等瀏覽器重畫。
describe("填的元件在伺服器上壞了", () => {
  /** 把 async 的伺服器元件一層一層解開,再交給 renderToStaticMarkup(它不會等)。 */
  async function resolve(node: ReactNode): Promise<ReactNode> {
    if (Array.isArray(node)) return Promise.all(node.map(resolve));
    if (!isValidElement<{ children?: ReactNode }>(node)) return node;
    const { type, props } = node;
    if (typeof type === "function" && !(type.prototype as { isReactComponent?: unknown } | undefined)?.isReactComponent) {
      return resolve(await (type as (p: unknown) => ReactNode | Promise<ReactNode>)(props));
    }
    if (props.children === undefined) return node;
    return cloneElement(node, undefined, await resolve(props.children));
  }
  const render = async (sources: SlotSource[]) => {
    runtime.slots = new SlotRegistry(sources);
    return renderToStaticMarkup(await resolve(await Slot({ of: Panel, props: { title: "T" }, children: fallback })));
  };
  const boom = () => {
    throw new Error("database is down");
  };
  const boomLater = async () => {
    throw new Error("database is down");
  };
  const logged = () => vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => vi.restoreAllMocks());

  it("前面的壞了:不畫它,其他照常", async () => {
    const errors = logged();
    expect(await render([{ extId: "a", fills: [fill(Panel, { before: boom }), fill(Panel, { before: tag("ok") }), fill(Panel, { after: boomLater })] }])).toBe("<i>ok:T</i><p>default</p>");
    // 只數插槽自己記的那兩筆(解開元件樹的測試工具會讓 React 另外抱怨少了 key)。
    expect(errors.mock.calls.filter(([message]) => String(message).includes("[slot:test.panel]"))).toHaveLength(2);
  });

  it("換掉的壞了:畫原本的內容", async () => {
    logged();
    expect(await render([{ extId: "a", fills: [fill(Panel, { replace: boomLater })] }])).toBe("<p>default</p>");
  });

  it("包起來的壞了:畫它本來要包的那一塊(裡面那層還在)", async () => {
    logged();
    expect(
      await render([
        { extId: "outer", layer: "site", fills: [fill(Panel, { wrap: boomLater })] },
        { extId: "inner", fills: [fill(Panel, { wrap: frame("inner") })] },
      ]),
    ).toBe('<section data-frame="inner"><p>default</p></section>');
  });

  it("redirect()、notFound() 不是壞掉:原樣往上丟", async () => {
    const signal = Object.assign(new Error("next"), { digest: "NEXT_REDIRECT;replace;/member/sign-in;307;" });
    const errors = logged();
    await expect(render([{ extId: "a", fills: [fill(Panel, { wrap: async () => { throw signal; } })] }])).rejects.toBe(signal);
    await expect(render([{ extId: "a", fills: [fill(Panel, { before: () => { throw signal; } })] }])).rejects.toBe(signal);
    expect(errors.mock.calls.filter(([message]) => String(message).includes("[slot:"))).toHaveLength(0);
  });

  it("包在別的錯誤裡的 redirect() 也認得(cause)", async () => {
    const signal = Object.assign(new Error("next"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    const wrapped = new Error("while loading", { cause: signal });
    await expect(render([{ extId: "a", fills: [fill(Panel, { replace: async () => { throw wrapped; } })] }])).rejects.toBe(wrapped);
  });

  it("client 元件不在伺服器上直接呼叫:照一般元件畫,壞了由瀏覽器那邊的 boundary 接", async () => {
    const ClientFill = Object.assign(({ title }: { title: string }) => <i>client:{title}</i>, { $$typeof: Symbol.for("react.client.reference") });
    runtime.slots = new SlotRegistry([{ extId: "a", fills: [fill(Panel, { before: ClientFill })] }]);
    const types: unknown[] = [];
    const walk = (node: ReactNode): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!isValidElement<{ children?: ReactNode }>(node)) return;
      types.push((node as ReactElement).type);
      walk(node.props.children);
    };
    walk(await Slot({ of: Panel, props: { title: "T" }, children: fallback }));
    expect(types).toContain(ClientFill);
  });
});

// 一個填的元件在瀏覽器畫壞了(SlotFillBoundary):只少它一個;換掉或包起來的壞了就畫原本的內容。
// renderToStaticMarkup 沒有 error boundary,所以直接看這個元件出錯之後畫什麼。
describe("填的元件畫壞了", () => {
  const failed = (props: { slot: string; fallback?: ReactNode; children?: ReactNode }) => {
    const boundary = new SlotFillBoundary(props);
    boundary.state = SlotFillBoundary.getDerivedStateFromError(new Error("boom"));
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

  // redirect()、notFound() 在 Next 裡是丟一個帶 digest 的例外;那不是畫壞,要原樣往上丟,Next 才換得了頁。
  it.each([
    ["redirect()", "NEXT_REDIRECT;replace;/member/sign-in;307;"],
    ["notFound()", "NEXT_HTTP_ERROR_FALLBACK;404"],
    ["改成只在瀏覽器畫", "BAILOUT_TO_CLIENT_SIDE_RENDERING"],
  ])("填的元件(或被包住的原本內容)呼叫 %s:原樣往上丟", (_name, digest) => {
    const signal = Object.assign(new Error("next"), { digest });
    expect(() => SlotFillBoundary.getDerivedStateFromError(signal)).toThrow(signal);
  });

  it("別的帶 digest 的錯誤照樣當成畫壞", () => {
    expect(SlotFillBoundary.getDerivedStateFromError(Object.assign(new Error("boom"), { digest: "1234567890" }))).toEqual({ failed: true });
    expect(SlotFillBoundary.getDerivedStateFromError("just a string")).toEqual({ failed: true });
  });
});
