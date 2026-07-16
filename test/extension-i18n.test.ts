import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/ext/dx/manifest";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";
import { resolveLocalizedString } from "../src/lib/i18n/localized";
import { fieldLabel, blockLabel } from "../src/ext/dx/views/field-utils";

// spec-extension-i18n.md(Option A:inline per-locale union)。三塊:
//   1. manifest 解析相容性(plain string / union 物件 / strict 拒未知鍵 / refine 拒空)。
//   2. resolveLocalizedString 的 fallback 鏈(locale → en → 任一鍵 → undefined)。
//   3. zh-Hant label 端到端(manifest → parseManifest → resolve helper 渲染字串)。

const base = {
  kind: "declarative" as const,
  id: "blog",
  name: "Blog",
  version: "1.0.0",
  coreApi: "^1.17.0",
};

describe("extension i18n — manifest 解析相容性(spec §3 Option A)", () => {
  it("純字串 label 照舊 parse(back-compat 硬需求)", () => {
    const r = parseManifest({
      ...base,
      name: "Blog",
      description: "A blog.",
      contentTypes: [
        { name: "post", label: "Posts", fields: [{ key: "title", type: "text", label: "Title" }] },
      ],
    });
    expect(r.ok).toBe(true);
    const ct = r.manifest?.contentTypes?.[0] as DeclarativeContentType;
    expect(ct.label).toBe("Posts");
    expect(ct.fields[0].label).toBe("Title");
  });

  it("per-locale 物件 label parse(union 第二分支)", () => {
    const r = parseManifest({
      ...base,
      name: { en: "Blog", "zh-Hant": "部落格" },
      contentTypes: [
        {
          name: "post",
          label: { en: "Posts", "zh-Hant": "文章" },
          fields: [{ key: "title", type: "text", label: { en: "Title", "zh-Hant": "標題" } }],
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.name).toEqual({ en: "Blog", "zh-Hant": "部落格" });
    const ct = r.manifest?.contentTypes?.[0] as DeclarativeContentType;
    expect(ct.label).toEqual({ en: "Posts", "zh-Hant": "文章" });
  });

  it("混用純字串與物件 label 於同一 manifest", () => {
    const r = parseManifest({
      ...base,
      contentTypes: [
        {
          name: "post",
          label: { en: "Posts", "zh-Hant": "文章" }, // 物件
          fields: [{ key: "title", type: "text", label: "Title" }], // 純字串
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("strict 拒未知 locale 鍵", () => {
    const r = parseManifest({
      ...base,
      contentTypes: [
        {
          name: "post",
          label: { en: "Posts", fr: "Articles" }, // fr 非白名單鍵
          fields: [{ key: "title", type: "text" }],
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("refine 拒空的 localized 物件(至少一鍵)", () => {
    const r = parseManifest({
      ...base,
      contentTypes: [
        { name: "post", label: {}, fields: [{ key: "title", type: "text" }] },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("settings label/description/option.label 皆吃 union;adminPage title 亦然", () => {
    const r = parseManifest({
      ...base,
      settings: [
        {
          key: "mode",
          label: { en: "Mode", "zh-Hant": "模式" },
          description: { en: "Display mode", "zh-Hant": "顯示模式" },
          default: "a",
          type: "select",
          options: [{ value: "a", label: { en: "A", "zh-Hant": "甲" } }],
        },
      ],
      contentTypes: [{ name: "post", fields: [{ key: "title", type: "text" }] }],
      adminPages: [
        { slug: "", title: { en: "Posts", "zh-Hant": "文章" }, view: "collection", contentType: "post" },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe("resolveLocalizedString — fallback 鏈(spec §4 / open-question #3)", () => {
  it("plain string 原樣回傳(與 locale 無關)", () => {
    expect(resolveLocalizedString("Title", "zh-Hant")).toBe("Title");
    expect(resolveLocalizedString("Title", "en")).toBe("Title");
  });

  it("請求的 locale 命中", () => {
    const v = { en: "Title", "zh-Hant": "標題" };
    expect(resolveLocalizedString(v, "zh-Hant")).toBe("標題");
    expect(resolveLocalizedString(v, "en")).toBe("Title");
  });

  it("缺請求 locale → 退回 en", () => {
    expect(resolveLocalizedString({ en: "Title" }, "zh-Hant")).toBe("Title");
  });

  it("缺請求 locale 且缺 en → 退回任一鍵(永不露機器 key)", () => {
    expect(resolveLocalizedString({ "zh-Hant": "標題" }, "en")).toBe("標題");
  });

  it("undefined 入 → undefined 出(呼叫端沿用既有 ?? fallback)", () => {
    expect(resolveLocalizedString(undefined, "en")).toBeUndefined();
    expect(resolveLocalizedString(undefined, "zh-Hant")).toBeUndefined();
  });
});

describe("zh-Hant label 端到端(manifest → parse → 單一 resolve 點渲染)", () => {
  it("content type label / 欄位 label / block label 在 zh-Hant 與 en 各渲染正確值", () => {
    const r = parseManifest({
      ...base,
      contentTypes: [
        {
          name: "post",
          label: { en: "Posts", "zh-Hant": "文章" },
          fields: [
            { key: "title", type: "text", label: { en: "Title", "zh-Hant": "標題" } },
            {
              key: "body",
              type: "blocks",
              label: { en: "Body", "zh-Hant": "內文" },
              blocks: [
                { name: "quote", label: { en: "Quote", "zh-Hant": "引言" }, fields: [{ key: "text", type: "text" }] },
              ],
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    const ct = r.manifest!.contentTypes![0];
    const titleField = ct.fields[0];
    const blockDef = ct.fields[1].blocks![0];

    // zh-Hant locale
    expect(resolveLocalizedString(ct.label, "zh-Hant")).toBe("文章");
    expect(fieldLabel(titleField, "zh-Hant")).toBe("標題");
    expect(blockLabel(blockDef, "zh-Hant")).toBe("引言");

    // en locale
    expect(resolveLocalizedString(ct.label, "en")).toBe("Posts");
    expect(fieldLabel(titleField, "en")).toBe("Title");
    expect(blockLabel(blockDef, "en")).toBe("Quote");
  });

  it("欄位未給 label 時 fieldLabel 退回機器 key(不受 locale 影響)", () => {
    const r = parseManifest({
      ...base,
      contentTypes: [{ name: "post", fields: [{ key: "slugKey", type: "text" }] }],
    });
    expect(r.ok).toBe(true);
    const f = r.manifest!.contentTypes![0].fields[0];
    expect(fieldLabel(f, "zh-Hant")).toBe("slugKey");
    expect(fieldLabel(f, "en")).toBe("slugKey");
  });
});
