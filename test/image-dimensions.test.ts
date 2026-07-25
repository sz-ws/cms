import { describe, it, expect } from "vitest";

// 檔頭嗅探。用手工組出的最小合法檔頭驗每種格式 —— 這一層是「上傳時記下原生尺寸」
// 的唯一來源,錯了就是每張圖都少 width/height(CLS 回歸),而且事後補不回來。

import { sniffImageSize } from "@/lib/image-dimensions";

function bytes(...parts: (number | number[])[]): Uint8Array {
  return new Uint8Array(parts.flat());
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function be16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}
function le16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function le24(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
}
function chars(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

describe("PNG", () => {
  const png = (w: number, h: number) =>
    bytes(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      be32(13),
      chars("IHDR"),
      be32(w),
      be32(h),
      [8, 6, 0, 0, 0],
    );

  it("reads IHDR", () => {
    expect(sniffImageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("rejects a truncated header", () => {
    expect(sniffImageSize(png(10, 10).slice(0, 16))).toBeNull();
  });
});

describe("GIF", () => {
  it("reads the logical screen descriptor (little-endian)", () => {
    const gif = bytes(chars("GIF89a"), le16(640), le16(480), [0x00, 0x00]);
    expect(sniffImageSize(gif)).toEqual({ width: 640, height: 480 });
  });

  it("accepts the 87a variant too", () => {
    const gif = bytes(chars("GIF87a"), le16(12), le16(34), [0x00, 0x00]);
    expect(sniffImageSize(gif)).toEqual({ width: 12, height: 34 });
  });
});

describe("JPEG", () => {
  /** SOI + 一個要跳過的 APP0 段 + SOF0。 */
  const jpeg = (w: number, h: number) =>
    bytes(
      [0xff, 0xd8],
      [0xff, 0xe0],
      be16(16),
      chars("JFIF"),
      [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
      [0xff, 0xc0],
      be16(17),
      [8],
      be16(h),
      be16(w),
      [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    );

  it("skips segments and reads SOF0", () => {
    expect(sniffImageSize(jpeg(4032, 3024))).toEqual({
      width: 4032,
      height: 3024,
    });
  });

  it("reads progressive SOF2 as well", () => {
    const j = jpeg(800, 600);
    j[j.indexOf(0xc0, 20)] = 0xc2; // SOF0 → SOF2
    expect(sniffImageSize(j)).toEqual({ width: 800, height: 600 });
  });

  it("gives up at SOS rather than scanning entropy data", () => {
    const j = bytes([0xff, 0xd8], [0xff, 0xda], be16(12), new Array(20).fill(0xc0));
    expect(sniffImageSize(j)).toBeNull();
  });
});

describe("WebP", () => {
  const riff = (fourcc: string, payload: number[]) =>
    bytes(
      chars("RIFF"),
      be32(0),
      chars("WEBP"),
      chars(fourcc),
      be32(payload.length),
      payload,
      new Array(16).fill(0), // 補足最小長度檢查
    );

  it("reads lossy VP8", () => {
    const payload = [0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, ...le16(1024), ...le16(768)];
    expect(sniffImageSize(riff("VP8 ", payload))).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it("reads lossless VP8L", () => {
    // 14-bit (w-1) 然後 14-bit (h-1),packed little-endian。
    const packed = (300 - 1) | ((200 - 1) << 14);
    const payload = [
      0x2f,
      packed & 0xff,
      (packed >>> 8) & 0xff,
      (packed >>> 16) & 0xff,
      (packed >>> 24) & 0xff,
    ];
    expect(sniffImageSize(riff("VP8L", payload))).toEqual({
      width: 300,
      height: 200,
    });
  });

  it("reads extended VP8X canvas size", () => {
    const payload = [0, 0, 0, 0, ...le24(2000 - 1), ...le24(1500 - 1)];
    expect(sniffImageSize(riff("VP8X", payload))).toEqual({
      width: 2000,
      height: 1500,
    });
  });
});

describe("AVIF / ISO BMFF", () => {
  const avif = (boxes: number[][]) =>
    bytes(be32(20), chars("ftyp"), chars("avif"), be32(0), chars("avif"), ...boxes);
  const ispe = (w: number, h: number) => [
    ...be32(20),
    ...chars("ispe"),
    ...be32(0),
    ...be32(w),
    ...be32(h),
  ];

  it("reads an ispe box", () => {
    expect(sniffImageSize(avif([ispe(3000, 2000)]))).toEqual({
      width: 3000,
      height: 2000,
    });
  });

  it("picks the largest ispe when a thumbnail is also present", () => {
    expect(sniffImageSize(avif([ispe(160, 120), ispe(3000, 2000)]))).toEqual({
      width: 3000,
      height: 2000,
    });
  });

  it("returns null for an ISO BMFF file with no ispe at all", () => {
    expect(sniffImageSize(avif([]))).toBeNull();
  });
});

describe("degradation", () => {
  it("returns null for unknown bytes rather than throwing", () => {
    expect(sniffImageSize(new Uint8Array(0))).toBeNull();
    expect(sniffImageSize(bytes(chars("not an image at all really")))).toBeNull();
    expect(sniffImageSize(new Uint8Array(64).fill(0xff))).toBeNull();
  });

  it("rejects a zero dimension", () => {
    const gif = bytes(chars("GIF89a"), le16(0), le16(100), [0, 0]);
    expect(sniffImageSize(gif)).toBeNull();
  });
});
