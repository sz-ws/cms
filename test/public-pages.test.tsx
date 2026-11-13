import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloneElement, isValidElement, type ComponentType, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 站台(或代理商、插件)經 core 那一個存起來的公開路由提供自己的頁面(src/ext/public-pages.ts、
// (public)/[[...slug]]/page.tsx、(public)/not-found.tsx、components/PublicFrame.tsx):
//   - 網址照層先問:站台、代理商、一般插件;同一層保持原本的順序。接得住 [] 的是首頁。
//   - metadata 來自接住的 route,再流過 PublicMetadata;viewport 流過 PublicViewport。
//   - 外框 PublicFrame 由 (public)/layout.tsx 畫(換頁時不重新掛載),拿到公告;沒有人填時跟以前的 layout 一樣。
//     照網址換樣子的外框用 usePathname()(test/fixtures/public-frame,就是 src/ext/META.md 的範例)。
//   - 404 畫在外框裡,內容是 PublicNotFound。

const runtime = vi.hoisted(() => ({
  enabled: [] as unknown[],
  unavailableById: new Map<string, { kind: string }>(),
  filters: {} as Record<string, unknown>,
  slots: null as unknown,
  notice: null as unknown,
  pathname: "/",
}));

vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({
    enabled: runtime.enabled,
    unavailableById: runtime.unavailableById,
    slots: runtime.slots,
    hooks: { applyFilters: async (name: string, base: unknown) => (name in runtime.filters ? runtime.filters[name] : base) },
  }),
}));
vi.mock("@/lib/site-notice-server", () => ({ getSiteNoticeWindow: async () => runtime.notice }));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback: unknown) => (key === "core.siteTitle" ? "Lab" : fallback),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => runtime.pathname,
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SlotRegistry, fill, type SlotFill, type SlotLayer } from "../src/ext/slots";
import { PublicFrame, PublicMetadata, PublicNotFound, PublicViewport } from "../src/ext/core-slots";
import { matchPublicRoute, publicRouteOrder, type PublicFrameProps } from "../src/ext/public-pages";
import { FramedPublicPage } from "../src/components/PublicFrame";
import { SiteNoticeBar } from "../src/app/(public)/site-notice";
import PublicPage, { generateMetadata, generateViewport } from "../src/app/(public)/[[...slug]]/page";
import PublicNotFoundPage from "../src/app/(public)/not-found";
import PublicLayout from "../src/app/(public)/layout";
import { SiteFrame } from "./fixtures/public-frame/site-frame";
import RootNotFound from "../src/app/not-found";
import { NotFoundMessage } from "../src/components/NotFoundMessage";

// ---- helpers ----

interface FakeExt {
  id: string;
  layer?: SlotLayer;
  fills?: SlotFill[];
  publicRoutes?: { match: (s: string[]) => Record<string, string> | null; component: ComponentType<{ params: Record<string, string> }>; metadata?: (p: Record<string, string>) => unknown }[];
}

function setup(exts: FakeExt[], filters: Record<string, unknown> = {}, notice: unknown = null) {
  runtime.enabled = exts;
  runtime.filters = filters;
  runtime.notice = notice;
  runtime.unavailableById = new Map();
  runtime.slots = new SlotRegistry(exts.map((e) => ({ extId: e.id, layer: e.layer, fills: e.fills })));
}

const exact = (...want: string[]) => (s: string[]) => (s.length === want.length && want.every((w, i) => s[i] === w) ? {} : null);
const named = (name: string) => {
  const C = ({ params }: { params: Record<string, string> }) => <p data-page={name}>{JSON.stringify(params)}</p>;
  return C;
};

/** 伺服器元件(可能 async)先展開成一般的樹,再交給 renderToStaticMarkup;用 hook 的(client 元件)留給它畫。 */
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function" && !(el.type.prototype as { isReactComponent?: unknown } | undefined)?.isReactComponent) {
    let out: unknown;
    try {
      out = (el.type as (p: unknown) => unknown)(el.props);
    } catch (error) {
      if (/hook|useContext|useEffect|useState|useRef|useSyncExternalStore|null/i.test(String(error))) return el;
      throw error;
    }
    return resolveTree((await out) as ReactNode);
  }
  const props: Record<string, unknown> = {};
  if ("children" in el.props) props.children = await resolveTree(el.props.children as ReactNode);
  if ("fallback" in el.props) props.fallback = await resolveTree(el.props.fallback as ReactNode);
  return cloneElement(el, props);
}

const html = async (node: ReactNode) => renderToStaticMarkup(<>{await resolveTree(node)}</>);
const open = (slug?: string[]) => PublicPage({ params: Promise.resolve({ slug }) });

beforeEach(() => setup([]));

// ---- dispatch ----

describe("public routes: who answers a URL", () => {
  const plugin = (id: string, path: string) => ({ id, publicRoutes: [{ match: exact(path), component: named(id) }] });

  it("site first, then agency, then plugins; plugins keep their relative order", () => {
    const exts = [plugin("p1", "x"), { ...plugin("site", "x"), layer: "site" as const }, plugin("p2", "x"), { ...plugin("agency", "x"), layer: "agency" as const }];
    expect(publicRouteOrder(exts).map((e) => e.id)).toEqual(["site", "agency", "p1", "p2"]);
    expect(matchPublicRoute(exts, ["x"])?.ext.id).toBe("site");
    expect(matchPublicRoute([plugin("p1", "x"), plugin("p2", "x")], ["x"])?.ext.id).toBe("p1");
    expect(matchPublicRoute([plugin("p2", "x"), plugin("p1", "x")], ["x"])?.ext.id).toBe("p2");
  });

  it("a site route overrides a plugin URL", async () => {
    setup([plugin("shop", "cart"), { ...plugin("site", "cart"), layer: "site" }]);
    expect(await html(await open(["cart"]))).toContain('data-page="site"');
  });

  it("a site route that calls notFound() hides a plugin URL", async () => {
    const Hidden = () => {
      throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    };
    setup([plugin("group", "group-buy"), { id: "site", layer: "site", publicRoutes: [{ match: (s) => (s[0] === "group-buy" ? {} : null), component: Hidden }] }]);
    await expect(html(await open(["group-buy"]))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("a route matching the empty path is the home page", async () => {
    setup([{ id: "site", layer: "site", publicRoutes: [{ match: (s) => (s.length === 0 ? {} : null), component: named("home") }] }], {
      "filter:publicHome": () => <p>filter home</p>,
    });
    const out = await html(await open(undefined));
    expect(out).toContain('data-page="home"');
    expect(out).not.toContain("filter home");
  });

  it("no route for the empty path: filter:publicHome, then the welcome page", async () => {
    setup([plugin("p", "x")], { "filter:publicHome": () => <p>filter home</p> });
    expect(await html(await open([]))).toContain("<p>filter home</p>");
    setup([plugin("p", "x")]);
    expect(await html(await open([]))).toContain('<h1 class="text-3xl font-semibold text-gray-900">Lab</h1>');
  });

  it("unmatched paths are 404", async () => {
    setup([plugin("p", "x")]);
    await expect(open(["y"])).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

// ---- metadata / viewport ----

describe("public routes: metadata and viewport", () => {
  const meta = (slug?: string[]) => generateMetadata({ params: Promise.resolve({ slug }) });
  const view = (slug?: string[]) => generateViewport({ params: Promise.resolve({ slug }) });

  it("nothing supplied: an empty object (the head does not change)", async () => {
    setup([{ id: "p", publicRoutes: [{ match: exact("x"), component: named("p") }] }]);
    expect(await meta(["x"])).toEqual({});
    expect(await meta([])).toEqual({});
    expect(await meta(["nope"])).toEqual({});
    expect(await view(["x"])).toEqual({});
  });

  it("the matched route's metadata, with its params", async () => {
    setup([{ id: "news", publicRoutes: [{ match: (s) => (s[0] === "news" && s.length === 2 ? { slug: s[1] } : null), component: named("n"), metadata: (p) => ({ title: `Post ${p.slug}` }) }] }]);
    expect(await meta(["news", encodeURIComponent("春季")])).toEqual({ title: "Post 春季" });
  });

  it("then every PublicMetadata step in fill order, each told which route this is", async () => {
    const seen: unknown[] = [];
    setup([
      { id: "site", layer: "site", fills: [fill(PublicMetadata, (steps) => [...steps, (m, { route }) => (seen.push(route), { ...m, title: `${String(m.title ?? "Home")} | Site` })])] },
      { id: "plugin", fills: [fill(PublicMetadata, (steps) => [...steps, async (m) => ({ ...m, description: "from plugin" })])], publicRoutes: [{ match: exact("x"), component: named("x"), metadata: () => ({ title: "X" }) }] },
    ]);
    expect(await meta(["x"])).toEqual({ title: "X | Site", description: "from plugin" });
    expect(await meta([])).toEqual({ title: "Home | Site", description: "from plugin" });
    expect(await meta(["%E6%98"])).toEqual({ title: "Home | Site", description: "from plugin" });
    expect(seen).toEqual([
      { kind: "page", path: ["x"], ext: "plugin" },
      { kind: "home", path: [], ext: null },
      { kind: "not-found", path: null, ext: null },
    ]);
  });

  it("a failing step fails the render (not stored) instead of being skipped", async () => {
    setup([{ id: "site", layer: "site", fills: [fill(PublicMetadata, (steps) => [...steps, () => { throw new Error("boom"); }])] }]);
    await expect(meta([])).rejects.toThrow("boom");
  });

  it("PublicViewport steps", async () => {
    setup([{ id: "site", layer: "site", fills: [fill(PublicViewport, (steps) => [...steps, (v, { route }) => ({ ...v, themeColor: route.kind === "home" ? "#000000" : "#ffffff" })])] }]);
    expect(await view([])).toEqual({ themeColor: "#000000" });
    expect(await view(["a"])).toEqual({ themeColor: "#ffffff" });
  });
});

// ---- frame ----

const Header = () => <header>H</header>;
const Footer = () => <footer>F</footer>;
const Widget = () => <aside>W</aside>;
const NOTICE = { text: "Closed on Monday" };

/** 改版前 (public)/layout.tsx 畫的樣子,一字不改 —— 對拍用的基準。 */
function LegacyLayout({ children, notice, Header: H, Footer: F, Widgets }: { children: ReactNode; notice: typeof NOTICE | null; Header: ComponentType | null; Footer: ComponentType | null; Widgets: ComponentType[] }) {
  return (
    <div className="flex min-h-screen flex-col">
      {notice && <SiteNoticeBar notice={notice} />}
      {H && <H />}
      <div className="flex-1">{children}</div>
      {F && <F />}
      {Widgets.map((W, i) => (
        <W key={i} />
      ))}
    </div>
  );
}

describe("public frame (in the layout)", () => {
  it.each([
    ["everything", NOTICE, Header, Footer, [Widget, Widget]],
    ["nothing", null, null, null, []],
  ] as const)("default frame (%s) is byte-identical to the 1.x–2.0 public layout", async (_name, notice, H, F, widgets) => {
    setup([], { "filter:publicHeader": H, "filter:publicFooter": F, "filter:publicWidgets": [...widgets] }, notice);
    const got = await html(<PublicLayout><p>content</p></PublicLayout>);
    const want = renderToStaticMarkup(<LegacyLayout notice={notice} Header={H} Footer={F} Widgets={[...widgets]}><p>content</p></LegacyLayout>);
    expect(got).toBe(want);
  });

  it("the page itself renders no frame (the frame is the layout's, so it persists across navigation)", async () => {
    setup([{ id: "p", publicRoutes: [{ match: exact("x"), component: named("x") }] }], { "filter:publicHeader": Header }, NOTICE);
    expect(await html(await open(["x"]))).toBe('<p data-page="x">{}</p>');
  });

  it("a frame fill gets the notice window and owns the whole frame; widgets still render after it", async () => {
    const got: unknown[] = [];
    const Frame = ({ notice, children }: PublicFrameProps) => {
      got.push(notice);
      return <section>{notice ? <em>{notice.text}</em> : null}{children}</section>;
    };
    setup([{ id: "site", layer: "site", fills: [fill(PublicFrame, { replace: Frame })] }], { "filter:publicHeader": Header, "filter:publicWidgets": [Widget] }, NOTICE);
    expect(await html(<PublicLayout><p>c</p></PublicLayout>)).toBe("<section><em>Closed on Monday</em><p>c</p></section><aside>W</aside>");
    expect(got).toEqual([NOTICE]);
  });

  it("the documented pattern: a client frame decides by usePathname (home bare, inner framed)", async () => {
    setup([{ id: "site", layer: "site", fills: [fill(PublicFrame, { replace: SiteFrame })] }], {}, NOTICE);
    runtime.pathname = "/";
    expect(await html(<PublicLayout><p>home</p></PublicLayout>)).toContain('<div class="my-site" data-frame="home"><p>home</p><p id="site-notice"');
    runtime.pathname = "/blog/a";
    const inner = await html(<PublicLayout><p>post</p></PublicLayout>);
    expect(inner).toContain('<div class="my-site" data-frame="inner"><header>Site header</header><p id="site-notice"');
    expect(inner).toContain("<p>post</p><footer>Site footer</footer></div>");
  });

  it("a frame fill that reads request data on a stored page fails loudly instead of falling back", async () => {
    const Frame = () => {
      throw Object.assign(new Error('Route with dynamic = "error" used cookies()'), { code: "NEXT_STATIC_GEN_BAILOUT" });
    };
    setup([{ id: "site", layer: "site", fills: [fill(PublicFrame, { replace: Frame })] }]);
    await expect(html(<PublicLayout><p>c</p></PublicLayout>)).rejects.toThrow(/dynamic = "error"/);
  });

  it("FramedPublicPage gives a site's own route group the same frame", async () => {
    setup([], { "filter:publicHeader": Header }, null);
    expect(await html(<FramedPublicPage><p>own</p></FramedPublicPage>)).toBe(await html(<PublicLayout><p>own</p></PublicLayout>));
  });
});

// ---- 404 ----

describe("public 404", () => {
  // 2.x:公開頁的 404 畫在 layout 的外框裡(以前由根的 not-found 畫、不在外框裡)。內容沒變。
  it("default: the root 404's content, inside the layout's frame", async () => {
    setup([], { "filter:publicHeader": Header, "filter:publicWidgets": [Widget] }, NOTICE);
    const want = renderToStaticMarkup(<LegacyLayout notice={NOTICE} Header={Header} Footer={null} Widgets={[Widget]}><RootNotFound /></LegacyLayout>);
    expect(await html(<PublicLayout><PublicNotFoundPage /></PublicLayout>)).toBe(want);
    expect(renderToStaticMarkup(<RootNotFound />)).toBe(renderToStaticMarkup(<NotFoundMessage />));
  });

  it("content from PublicNotFound, inside a replaced frame", async () => {
    const Frame = ({ children }: PublicFrameProps) => <section>{children}</section>;
    const Oops = () => <p>Oops</p>;
    setup([{ id: "site", layer: "site", fills: [fill(PublicFrame, { replace: Frame }), fill(PublicNotFound, { replace: Oops })] }]);
    expect(await html(<PublicLayout><PublicNotFoundPage /></PublicLayout>)).toBe("<section><p>Oops</p></section>");
  });
});
