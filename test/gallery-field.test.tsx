import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseManifest, type DeclarativeField } from "../src/ext/dx/manifest";
import { ContentValidationError, validateFieldSet } from "../src/ext/dx/content-provider";
import { buildFieldValue, toFieldValue } from "../src/ext/dx/fields/field-values";
import { GalleryField, moveKey } from "../src/ext/dx/fields/GalleryField";
import { collectMediaKeys } from "../src/ext/dx/views/media-dims";
import { catalogManifest } from "../src/ext/commerce-kit/catalog";
import { GALLERY_MAX } from "../src/ext/dx/media-key";
import type { ContentFieldDef } from "../src/ext/capabilities";

// core 1.66.0:gallery 欄位(多張圖)。值是有序的 media key 陣列。

const A = "catalog/2026/09/a.jpg";
const B = "catalog/2026/09/b.jpg";
const C = "catalog/2026/09/c.png";

const manifest = (coreApi: string, fields: unknown[]) => ({
  kind: "declarative" as const,
  id: "shelf",
  name: "Shelf",
  version: "1.0.0",
  coreApi,
  contentTypes: [{ name: "item", fields: [{ key: "title", type: "text" }, ...fields] }],
});

const issues = (r: ReturnType<typeof parseManifest>) => (r.ok ? [] : JSON.stringify(r));

describe("gallery in a manifest", () => {
  it("takes a gallery field, at the top level or inside a repeater, from coreApi 1.66.0", () => {
    expect(parseManifest(manifest("^1.66.0", [{ key: "photos", type: "gallery", max: 8 }])).ok).toBe(true);
    expect(
      parseManifest(
        manifest("^1.66.0", [{ key: "rows", type: "repeater", fields: [{ key: "photos", type: "gallery" }] }]),
      ).ok,
    ).toBe(true);
  });

  it("asks for coreApi 1.66.0, also when the gallery is nested", () => {
    expect(issues(parseManifest(manifest("^1.65.0", [{ key: "photos", type: "gallery" }])))).toContain(
      'gallery fields require coreApi \\"^1.66.0\\" or newer',
    );
    expect(
      parseManifest(
        manifest("^1.65.0", [{ key: "rows", type: "repeater", fields: [{ key: "photos", type: "gallery" }] }]),
      ).ok,
    ).toBe(false);
  });

  it("allows max only on gallery fields, up to the core limit", () => {
    expect(issues(parseManifest(manifest("^1.66.0", [{ key: "name", type: "text", max: 3 }])))).toContain(
      "only valid on gallery fields",
    );
    expect(parseManifest(manifest("^1.66.0", [{ key: "photos", type: "gallery", max: GALLERY_MAX + 1 }])).ok).toBe(false);
    expect(parseManifest(manifest("^1.66.0", [{ key: "photos", type: "gallery", max: 0 }])).ok).toBe(false);
  });

  it("gives the catalog product more photos and detail images, and still parses", () => {
    const product = (catalogManifest().contentTypes as { name: string; fields: { key: string; type: string; max?: number }[] }[]).find(
      (ct) => ct.name === "product",
    )!;
    expect(product.fields.filter((f) => f.type === "gallery").map((f) => [f.key, f.max])).toEqual([
      ["moreImages", 12],
      ["detailImages", undefined],
    ]);
    expect(product.fields.find((f) => f.key === "image")?.type).toBe("media");
    expect(parseManifest(catalogManifest()).ok).toBe(true);
  });
});

describe("gallery values", () => {
  const photos: ContentFieldDef = { key: "photos", type: "gallery", max: 3 };
  const reject = (data: Record<string, unknown>, fields: ContentFieldDef[] = [photos]) => {
    try {
      validateFieldSet(fields, data, "");
    } catch (e) {
      expect(e).toBeInstanceOf(ContentValidationError);
      return (e as Error).message;
    }
    throw new Error("expected the value to be rejected");
  };

  it("stores an ordered copy of the keys", () => {
    const input = [B, A];
    const out = validateFieldSet([photos], { photos: input }, "");
    expect(out.photos).toEqual([B, A]);
    expect(out.photos).not.toBe(input);
  });

  it("rejects urls, paths and non-strings, more than max, and anything but a list", () => {
    expect(reject({ photos: ["https://evil.example/a.png"] })).toContain("invalid media key");
    expect(reject({ photos: ["../../etc/passwd"] })).toContain("invalid media key");
    expect(reject({ photos: [A, 3] })).toContain("invalid media key");
    expect(reject({ photos: [A, B, C, A] })).toContain("at most 3 images");
    expect(reject({ photos: A })).toContain("expected an array of media keys");
  });

  it("keeps an empty list unless the field is required", () => {
    expect(validateFieldSet([photos], { photos: [] }, "").photos).toEqual([]);
    expect(reject({ photos: [] }, [{ ...photos, required: true }])).toContain("required");
  });

  it("round-trips through the form and leaves an empty gallery unset", () => {
    const field = { key: "photos", type: "gallery" } as DeclarativeField;
    expect(toFieldValue(field, [A, 7, B])).toEqual([A, B]);
    expect(toFieldValue(field, undefined)).toEqual([]);
    expect(buildFieldValue(field, [A, B])).toEqual([A, B]);
    expect(buildFieldValue(field, [])).toBeUndefined();
  });

  it("collects every gallery key for the image sizes, nested ones too", () => {
    const fields = [
      { key: "cover", type: "media" },
      { key: "photos", type: "gallery" },
      { key: "rows", type: "repeater", fields: [{ key: "shots", type: "gallery" }] },
    ] as DeclarativeField[];
    const keys = collectMediaKeys(fields, { cover: A, photos: [B, "bad key"], rows: [{ shots: [C, A] }] });
    expect(keys.sort()).toEqual([A, B, C].sort());
  });
});

describe("gallery field in the form", () => {
  it("moves a photo one place and leaves the ends alone", () => {
    expect(moveKey([A, B, C], 1, -1)).toEqual([B, A, C]);
    expect(moveKey([A, B, C], 1, 1)).toEqual([A, C, B]);
    expect(moveKey([A, B, C], 0, -1)).toEqual([A, B, C]);
    expect(moveKey([A, B, C], 2, 1)).toEqual([A, B, C]);
  });

  it("shows numbered tiles with their controls, and turns off adding when full", () => {
    const field = { key: "photos", type: "gallery", max: 2 } as DeclarativeField;
    const html = renderToStaticMarkup(createElement(GalleryField, { field, value: [A, B], onChange: () => {} }));
    expect(html).toContain("2 / 2");
    expect(html).toContain("Remove image 1");
    expect(html).toContain("Move image 2 later");
    // 第一張不能再往前、最後一張不能再往後,「加入圖片」在滿了時停用。
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Move image 1 earlier"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Move image 2 later"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Add images/);
  });

  it("says how to add images when it is empty", () => {
    const field = { key: "photos", type: "gallery" } as DeclarativeField;
    const html = renderToStaticMarkup(createElement(GalleryField, { field, value: [], onChange: () => {} }));
    expect(html).toContain("No images yet");
    expect(html).toContain(`0 / ${GALLERY_MAX}`);
  });
});
