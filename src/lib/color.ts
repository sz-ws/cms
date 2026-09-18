// 後台主色(core.adminAccent)用的色彩工具。純函式,server 與 client 共用。
//
// 主色只存一個 `#rrggbb`;淡色、深色、陰影都在 CSS 用 color-mix() 從它推(見
// globals.css 的 --admin-accent)。這裡只做三件 CSS 做不到或不該做的事:驗證與正規化
// 使用者輸入、自訂色盤的 HSV ↔ hex 換算、決定主色上的字要黑還是白。

export interface Hsv {
  /** 0–360 */
  h: number;
  /** 0–100 */
  s: number;
  /** 0–100 */
  v: number;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#abc` / `abc` / `#AABBCC` → `#aabbcc`;不是合法 hex 回 null。 */
export function normalizeHex(input: string): string | null {
  const m = HEX_RE.exec(input.trim());
  if (!m) return null;
  const body = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${body.toLowerCase()}`;
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hexToHsv(hex: string): Hsv {
  const [r, g, b] = channels(normalizeHex(hex) ?? "#000000").map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return {
    h: Math.round((h * 60 + 360) % 360),
    s: Math.round(max === 0 ? 0 : (d / max) * 100),
    v: Math.round(max * 100),
  };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const sat = Math.min(Math.max(s, 0), 100) / 100;
  const val = Math.min(Math.max(v, 0), 100) / 100;
  const k = (n: number) => (n + ((((h % 360) + 360) % 360) / 60)) % 6;
  const f = (n: number) => val - val * sat * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return `#${[f(5), f(3), f(1)]
    .map((c) => Math.round(c * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** WCAG 相對亮度(0 黑 – 1 白)。 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(normalizeHex(hex) ?? "#000000").map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 主色當底時字用黑或白。主色上的字多半是勾勾、小徽章這類 UI 元件,白字對比
 * 達 3:1(WCAG 1.4.11)就用白字 —— 後台一路是藍底白字;淺色主色(黃、淡粉)
 * 白字會看不見,才換黑字。
 */
export function readableOn(hex: string): "#ffffff" | "#000000" {
  const onWhite = 1.05 / (relativeLuminance(hex) + 0.05);
  return onWhite >= 3 ? "#ffffff" : "#000000";
}
