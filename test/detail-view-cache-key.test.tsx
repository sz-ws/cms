import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  cachedGet: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/link", () => ({
  default: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "zh-Hant" }));
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
});
