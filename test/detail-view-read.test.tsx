import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  providerGet: vi.fn(),
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
  resolveRelations: async () => [],
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
});
