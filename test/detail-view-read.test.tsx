import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  providerGet: vi.fn(),
  resolve: vi.fn(async () => [] as unknown[]),
  draft: false,
}));

// 2.0 草稿預覽:存起來的那一次渲染裡 draftMode 是關的;編輯開了 draft mode 時是逐請求渲染。
vi.mock("next/headers", () => ({
  draftMode: async () => ({ isEnabled: calls.draft }),
}));
vi.mock("@/ext/dx/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@/ext/dx/runtime")>();
  return { ...actual, getContentProvider: async () => ({ getBySlug: calls.providerGet }) };
});

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/link", () => ({
  default: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "zh-Hant" }));
vi.mock("@/lib/datetime-server", () => ({ getSiteTimeZone: async () => "Asia/Taipei" }));
vi.mock("@/ext/dx/relation-resolve", () => ({
  resolveRelations: calls.resolve,
}));
vi.mock("@/ext/dx/views/media-dims", async (importActual) => {
  const actual = await importActual<typeof import("@/ext/dx/views/media-dims")>();
  return { ...actual, loadMediaDims: async () => new Map() };
});

import { DetailView } from "../src/ext/dx/views/DetailView";

// 2.0:DetailView 直接讀 content provider(整頁存起來的是這次渲染的結果,沒有另一層資料快取)。
describe("DetailView reads the entry from the provider", () => {
  it("keeps English content reachable when the admin interface is Chinese", async () => {
    calls.providerGet.mockImplementationOnce(async (_type: string, _slug: string, locale?: string) => locale ? null : ({
      id: "about-zh",
      type: "pages.page",
      locale: "en",
      translationGroup: "about",
      slug: "about",
      status: "published",
      data: { title: "關於" },
      createdAt: 1,
      updatedAt: 1,
    }));

    await DetailView({
      extId: "pages",
      slug: "about",
      contentType: {
        name: "page",
        slugField: "title",
        fields: [{ key: "title", type: "text" }],
      },
    });

    // 不帶 locale:core.locale 是管理介面語言,不能拿來過濾內容。
    expect(calls.providerGet).toHaveBeenCalledWith("pages.page", "about");
  });

  it("2.0: in draft mode shows a draft", async () => {
    calls.draft = true;
    calls.providerGet.mockClear();
    calls.providerGet.mockResolvedValueOnce({
      id: "d1", type: "pages.page", locale: "en", translationGroup: "d1", slug: "soon",
      status: "draft", data: { title: "還沒發佈" }, createdAt: 1, updatedAt: 1,
    });
    const out = await DetailView({
      extId: "pages",
      slug: "soon",
      contentType: { name: "page", slugField: "title", fields: [{ key: "title", type: "text" }] },
    });
    expect(calls.providerGet).toHaveBeenCalledWith("pages.page", "soon");
    expect(JSON.stringify(out)).toContain("還沒發佈");
    calls.draft = false;
  });

  it("2.0: outside draft mode a draft is still a 404", async () => {
    calls.providerGet.mockResolvedValueOnce({
      id: "d1", type: "pages.page", locale: "en", translationGroup: "d1", slug: "soon",
      status: "draft", data: { title: "還沒發佈" }, createdAt: 1, updatedAt: 1,
    });
    await expect(
      DetailView({ extId: "pages", slug: "soon", contentType: { name: "page", slugField: "title", fields: [{ key: "title", type: "text" }] } }),
    ).rejects.toThrow("notFound");
  });

  // 關聯欄位:公開頁只列已發佈的項目;全被排除時整欄不出現(與沒有關聯一樣),
  // 草稿預覽才連草稿一起列出。
  const relType = {
    name: "post",
    slugField: "title",
    fields: [
      { key: "title", type: "text" as const },
      { key: "tags", type: "relations" as const, to: "blog.tag", label: "相關標籤" },
    ],
  };
  const relEntry = {
    id: "p1", type: "blog.post", locale: "en", translationGroup: "p1", slug: "p1",
    status: "published", data: { title: "P1", tags: ["t-draft"] }, createdAt: 1, updatedAt: 1,
  };

  it("public render asks for published related items only; an emptied field is left out", async () => {
    calls.resolve.mockClear();
    calls.providerGet.mockResolvedValueOnce(relEntry);
    const out = await DetailView({ extId: "blog", slug: "p1", contentType: relType });
    expect(calls.resolve).toHaveBeenCalledWith("blog.tag", ["t-draft"], { includeDrafts: false });
    expect(JSON.stringify(out)).not.toContain("相關標籤");
  });

  it("draft preview asks for draft related items too", async () => {
    calls.draft = true;
    calls.resolve.mockClear();
    calls.resolve.mockResolvedValueOnce([{ id: "t-draft", title: "草稿標籤", href: null }]);
    calls.providerGet.mockResolvedValueOnce(relEntry);
    const out = await DetailView({ extId: "blog", slug: "p1", contentType: relType });
    expect(calls.resolve).toHaveBeenCalledWith("blog.tag", ["t-draft"], { includeDrafts: true });
    expect(JSON.stringify(out)).toContain("草稿標籤");
    calls.draft = false;
  });
});
