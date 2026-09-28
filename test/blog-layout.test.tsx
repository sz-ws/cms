import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// blog 的編輯版面(extensions/blog/layout.tsx)。回歸:存檔曾經寫死 status "draft",
// 每存一次就把已發佈的文章打回草稿,版面上也沒有發佈的地方。現在帶著目前狀態存,
// 狀態在版面裡切(同泛用 FormView)。額外欄位的面板也在這裡。

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, refresh: () => {}, push: () => {} }),
}));
// next/dynamic 在 workers pool 載不起來;版面裡只有內文編輯器(ssr:false)用它,這裡畫空的。
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { getMessages } from "@/lib/i18n/index";
import { buildBlogPayload } from "../extensions/blog/payload";
import { BlogLayout } from "../extensions/blog/layout";
import type { LayoutComponentProps } from "@/ext/dx/extension-layouts";
import type { ExtraFieldDef } from "@/lib/extra-fields";

const STRINGS = {
  title: "Hello",
  slug: "hello",
  excerpt: "",
  cover: "",
  author: "",
  publishedAt: "",
};

const DEFS: ExtraFieldDef[] = [
  { key: "subtitle", label: "副標題", type: "text", public: true },
  { key: "pinned", label: "置頂", type: "boolean", public: false },
];

describe("buildBlogPayload", () => {
  it("keeps a published post published", () => {
    const payload = buildBlogPayload({
      strings: STRINGS,
      body: "",
      status: "published",
      publishAt: 1_900_000_000_000,
      extraFields: [],
      extra: {},
    });
    expect(payload.status).toBe("published");
    // 已發佈沒有排程可言(同 FormView)。
    expect(payload.publishAt).toBeNull();
    expect(payload).not.toHaveProperty("extra");
  });

  it("sends a draft with its schedule", () => {
    const payload = buildBlogPayload({
      strings: { ...STRINGS, publishedAt: "2026-09-01" },
      body: "",
      status: "draft",
      publishAt: 1_900_000_000_000,
      extraFields: [],
      extra: {},
    });
    expect(payload).toMatchObject({ status: "draft", publishAt: 1_900_000_000_000 });
    expect(payload.publishedAt).toBe(Date.parse("2026-09-01"));
  });

  it("sends the whole extra object, coerced to the definitions", () => {
    const payload = buildBlogPayload({
      strings: STRINGS,
      body: "",
      status: "draft",
      publishAt: null,
      extraFields: DEFS,
      extra: { subtitle: "  Hi  ", pinned: true, junk: "x" },
    });
    expect(payload.extra).toEqual({ subtitle: "Hi", pinned: true });
  });
});

function renderBlog(props: Partial<LayoutComponentProps>) {
  const locale = props.locale ?? "zh-Hant";
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale, messages: getMessages(locale) },
      createElement(BlogLayout, {
        extId: "blog",
        typeName: "post",
        fields: [],
        backHref: "/admin/ext/blog",
        ...props,
        locale,
      }),
    ),
  );
}

describe("BlogLayout", () => {
  it("shows the entry's current status and offers the switch", () => {
    const html = renderBlog({
      initialId: "p1",
      initialData: { title: "Hello" },
      initialStatus: "published",
    });
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>已發布</);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>草稿</);
    // 已發佈就沒有排程控制項。
    expect(html).not.toContain("排程發布");
  });

  it("renders the additional fields with their stored values", () => {
    const html = renderBlog({
      initialId: "p1",
      initialData: { title: "Hello", extra: { subtitle: "舊的副標" } },
      initialStatus: "draft",
      extraFields: DEFS,
    });
    expect(html).toContain("額外欄位");
    expect(html).toContain("副標題");
    expect(html).toContain('id="field-extra-subtitle"');
    expect(html).toContain('value="舊的副標"');
    expect(html).toContain("置頂");
  });

  it("has no additional fields section when none are defined", () => {
    const html = renderBlog({ initialData: {}, extraFields: [] });
    expect(html).not.toContain("額外欄位");
  });

  // 以前版面上的字全寫死英文;現在照後台語言(core 字典 blogEditor.* 與 extForm.admin.*)。
  const ENGLISH = [
    "Add cover",
    "Change cover",
    "Generate from OG",
    "Untitled",
    "Author",
    "Jane Doe",
    "Published",
    "Slug",
    "Excerpt",
    "A short hook",
    "Body",
    "Ready to save",
    "Up to date",
    "Unsaved changes",
    "Notion-style",
    "Discard",
    ">Save<",
  ];

  it("reads in Chinese when the admin is in Chinese", () => {
    const html = renderBlog({ initialData: { title: "Hello" } });
    for (const text of ["加上封面", "預覽分享圖", 'placeholder="未命名"', "作者", 'placeholder="王小明"', "發布日期", "網址代稱", "摘要", "內文", "已是最新", "尚無變更", "捨棄", "儲存"]) {
      expect(html).toContain(text);
    }
    for (const text of ENGLISH) expect(html).not.toContain(text);
  });

  it("reads in English when the admin is in English", () => {
    const html = renderBlog({ locale: "en", initialId: "p1", initialData: { title: "Hello", cover: "blog/a.png" } });
    for (const text of ["Change cover", 'placeholder="Untitled"', "Author", "Publish date", "Slug", "Excerpt", "Body", "Up to date", "No changes yet.", "Discard", ">Save<"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("加上封面");
    expect(html).not.toContain("Notion-style");
  });
});
