import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  cachedGet: vi.fn(),
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
vi.mock("@/ext/dx/content-cache", () => ({
  cachedPublicGetBySlug: calls.cachedGet,
}));
vi.mock("@/ext/dx/relation-resolve", () => ({
  resolveRelations: async () => [],
}));
vi.mock("@/ext/dx/views/media-dims", async (importActual) => {
  const actual = await importActual<typeof import("@/ext/dx/views/media-dims")>();
  return { ...actual, loadMediaDims: async () => new Map() };
});

import { DetailView } from "../src/ext/dx/views/DetailView";

describe("DetailView public content cache key", () => {
  it("keeps English content reachable when the admin interface is Chinese", async () => {
    calls.cachedGet.mockImplementationOnce(async (_ext: string, _type: string, _slug: string, locale?: string) => locale ? null : ({
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

    expect(calls.cachedGet).toHaveBeenCalledWith(
      "pages",
      "pages.page",
      "about",
    );
  });

  it("2.0: in draft mode reads the provider directly and shows a draft", async () => {
    calls.draft = true;
    calls.cachedGet.mockClear();
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
    expect(calls.cachedGet).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).toContain("還沒發佈");
    calls.draft = false;
  });

  it("2.0: outside draft mode a draft is still a 404", async () => {
    calls.cachedGet.mockResolvedValueOnce({
      id: "d1", type: "pages.page", locale: "en", translationGroup: "d1", slug: "soon",
      status: "draft", data: { title: "還沒發佈" }, createdAt: 1, updatedAt: 1,
    });
    await expect(
      DetailView({ extId: "pages", slug: "soon", contentType: { name: "page", slugField: "title", fields: [{ key: "title", type: "text" }] } }),
    ).rejects.toThrow("notFound");
  });
});
