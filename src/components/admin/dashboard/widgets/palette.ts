import { ACCENT } from "../styles";

// 佔比家族的色階:同一個主色用遞減透明度做出「同色系深淺」而非撞色
// 調色盤 —— 呼應 dashboard 既有「全站唯一強調色」的規則(styles.ts ACCENT 註解)。
// 超過 6 段落回中性灰,避免無限段落時色階失去可辨識度。
const OPACITIES = [1, 0.75, 0.55, 0.4, 0.28, 0.18];
const OVERFLOW = "rgba(0,0,0,0.12)";

export function segmentColor(index: number): string {
  if (index >= OPACITIES.length) return OVERFLOW;
  const alpha = OPACITIES[index];
  // 主色是 CSS 變數(站台可換),透明度用 color-mix 疊,不能拆 rgb 數字。
  return alpha === 1 ? ACCENT : `color-mix(in srgb, ${ACCENT} ${alpha * 100}%, transparent)`;
}
