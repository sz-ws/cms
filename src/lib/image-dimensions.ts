// 從圖片檔頭嗅出原生寬高。純函式、零相依 —— 刻意不用 env.IMAGES.info():
//
//   1. info() 需要帳號開通 Cloudflare Images。上傳是**寫入路徑**,不能把「記不記得
//      尺寸」綁在一個可能沒開的付費功能上;沒尺寸的圖之後就永遠沒尺寸(R2 不會
//      重跑上傳)。
//   2. 這裡只讀檔頭的前幾十個 byte,成本比一次 binding round-trip 低一個數量級。
//   3. 純函式可以在 vitest 裡直接餵 byte 陣列驗,不必 mock binding。
//
// 支援 PNG / JPEG / GIF / WebP / AVIF(HEIF 系)。認不出來一律回 null —— 呼叫端
// 當成「這張圖沒有尺寸資訊」,render 時就不放 width/height,行為退回現況。

export interface ImageSize {
  width: number;
  height: number;
}

/** 嗅探只需要檔頭;上傳端切這麼多 byte 出來就夠(AVIF 的 ispe 可能稍後才出現)。 */
export const SNIFF_BYTES = 64 * 1024;

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32be(b: Uint8Array, o: number): number {
  return (
    ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
  );
}
function u24le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

/** b 從 offset 起是否等於這串 ASCII。 */
function ascii(b: Uint8Array, o: number, s: string): boolean {
  if (o + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null;
  for (let i = 0; i < PNG_SIG.length; i++) if (b[i] !== PNG_SIG[i]) return null;
  // 8..12 = IHDR 長度,12..16 = "IHDR",16..24 = width/height(big-endian)。
  if (!ascii(b, 12, "IHDR")) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function gifSize(b: Uint8Array): ImageSize | null {
  if (b.length < 10) return null;
  if (!ascii(b, 0, "GIF87a") && !ascii(b, 0, "GIF89a")) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

/** 有 frame header 的 JPEG SOF marker(排除 DHT/DAC/RST 等同號段)。 */
function isSofMarker(m: number): boolean {
  if (m < 0xc0 || m > 0xcf) return false;
  return m !== 0xc4 && m !== 0xc8 && m !== 0xcc; // DHT / JPG / DAC
}

function jpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++; // fill byte / 對不齊時逐 byte 找回下一個 marker
      continue;
    }
    const marker = b[o + 1];
    if (marker === 0xff) {
      o++;
      continue;
    }
    // 沒有 payload 的 marker(TEM / RSTn)。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      o += 2;
      continue;
    }
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    if (isSofMarker(marker)) {
      // payload:precision(1) + height(2) + width(2)
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    if (marker === 0xda) return null; // SOS:影像資料開始,再往後找不到 SOF 了
    o += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  const chunk = 12; // RIFF(4) + size(4) + "WEBP"(4)
  const payload = chunk + 8; // + fourcc(4) + chunk size(4)

  if (ascii(b, chunk, "VP8X")) {
    // 擴充格式:canvas width-1 / height-1,各 24-bit little-endian。
    return {
      width: u24le(b, payload + 4) + 1,
      height: u24le(b, payload + 7) + 1,
    };
  }
  if (ascii(b, chunk, "VP8L")) {
    // 無損:signature(0x2f) 後 14-bit width-1、14-bit height-1,packed little-endian。
    if (b[payload] !== 0x2f) return null;
    const bits = (b[payload + 1] |
      (b[payload + 2] << 8) |
      (b[payload + 3] << 16) |
      (b[payload + 4] << 24)) >>> 0;
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (ascii(b, chunk, "VP8 ")) {
    // 有損:frame tag(3) + sync code 9d 01 2a(3),之後是 14-bit 寬高。
    const f = payload + 3;
    if (b[f] !== 0x9d || b[f + 1] !== 0x01 || b[f + 2] !== 0x2a) return null;
    return {
      width: u16le(b, f + 3) & 0x3fff,
      height: u16le(b, f + 5) & 0x3fff,
    };
  }
  return null;
}

/**
 * AVIF / HEIF:ISO BMFF 容器,尺寸在 `ispe` box(version+flags 4 byte,再兩個 uint32)。
 *
 * 不做完整 box tree 走訪 —— 直接掃 "ispe" 字面值,取**面積最大**的那一組。
 * 理由:一個 AVIF 常同時含縮圖 / alpha 輔助圖的 ispe,主圖(pitm 指的那個)才是
 * 我們要的,而主圖在實務上就是最大的那張。完整解析 meta/iprp/ipco/ipma 的成本
 * 遠高於這裡能換到的正確性。
 */
function isoBmffSize(b: Uint8Array): ImageSize | null {
  if (b.length < 12 || !ascii(b, 4, "ftyp")) return null;
  let best: ImageSize | null = null;
  // 邊界:讀到 height 的最後一個 byte 是 o+15,所以需要 o+16 個 byte 可讀。
  for (let o = 0; o + 16 <= b.length; o++) {
    if (!ascii(b, o, "ispe")) continue;
    const width = u32be(b, o + 8);
    const height = u32be(b, o + 12);
    if (width <= 0 || height <= 0) continue;
    if (!best || width * height > best.width * best.height) {
      best = { width, height };
    }
  }
  return best;
}

/**
 * 嗅出寬高;認不出格式、或檔頭被截斷 → null。
 * 回傳的寬高保證都是正整數(任一邊為 0 一律當成失敗)。
 */
export function sniffImageSize(bytes: Uint8Array): ImageSize | null {
  const size =
    pngSize(bytes) ??
    jpegSize(bytes) ??
    gifSize(bytes) ??
    webpSize(bytes) ??
    isoBmffSize(bytes);
  if (!size) return null;
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height)) return null;
  if (size.width <= 0 || size.height <= 0) return null;
  return size;
}
