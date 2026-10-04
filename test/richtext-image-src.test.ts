import { describe, it, expect } from "vitest";
import {
  normalizeRichtextImages,
  richtextImageSrc,
} from "../src/ext/dx/fields/richtext-schema";
import { validateFieldSet } from "../src/ext/dx/content-provider";

// 內文圖片的 src 只有一種寫法會被畫出來:`/api/files/<media key>`(編輯器插入的就是這個)。
// 助理手上只有 media key 與完整網址(core.media.list 的 key / url),兩種都曾被它原樣寫進
// 文件 —— 存得進去、前台卻不畫,沒有任何錯誤。寫入時把認得出來的寫法收斂成同一種。

const KEY = "core/2026/10/abc123.png";
const PATH = `/api/files/${KEY}`;

describe("richtextImageSrc", () => {
  it("已經是 /api/files/<key> → 原樣", () => {
    expect(richtextImageSrc(PATH)).toBe(PATH);
  });

  it("只有 media key → 補上 /api/files/", () => {
    expect(richtextImageSrc(KEY)).toBe(PATH);
  });

  it("完整網址(core.media.list 的 url)→ 取路徑", () => {
    expect(richtextImageSrc(`https://www.example.com${PATH}`)).toBe(PATH);
    expect(richtextImageSrc(`https://www.example.com${PATH}?w=640`)).toBe(PATH);
  });

  it("認不出來的 → null(外站圖片、路徑跳脫、不是字串)", () => {
    for (const src of [
      "https://cdn.example.com/a.jpg",
      "/api/files/../secret.png",
      "core/2026/10/../../x.png",
      "data:image/png;base64,AAAA",
      "",
      null,
      42,
    ]) {
      expect(richtextImageSrc(src)).toBeNull();
    }
  });
});

describe("normalizeRichtextImages", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "前言" }] },
      { type: "image", attrs: { src: KEY, alt: "論壇現場" } },
      {
        type: "blockquote",
        content: [{ type: "image", attrs: { src: `https://www.example.com${PATH}`, alt: null } }],
      },
      { type: "image", attrs: { src: "https://cdn.example.com/a.jpg" } },
    ],
  };

  it("把每張認得出來的圖片改成 /api/files/<key>,其餘節點與屬性不動", () => {
    const out = normalizeRichtextImages(doc);
    expect(out.content?.[0]).toEqual(doc.content[0]);
    expect(out.content?.[1]).toEqual({ type: "image", attrs: { src: PATH, alt: "論壇現場" } });
    expect(out.content?.[2]?.content?.[0]).toEqual({ type: "image", attrs: { src: PATH, alt: null } });
    // 認不出來的留著原樣:這裡只收斂寫法,不決定收不收。
    expect(out.content?.[3]).toEqual(doc.content[3]);
  });

  it("不改動傳進來的文件", () => {
    const before = JSON.stringify(doc);
    normalizeRichtextImages(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("寫入內容時", () => {
  it("richtext 欄位裡的圖片存成 /api/files/<key>", () => {
    const out = validateFieldSet(
      [{ key: "body", type: "richtext" }],
      { body: { type: "doc", content: [{ type: "image", attrs: { src: KEY } }] } },
      "",
    );
    expect(out.body).toEqual({ type: "doc", content: [{ type: "image", attrs: { src: PATH } }] });
  });
});
