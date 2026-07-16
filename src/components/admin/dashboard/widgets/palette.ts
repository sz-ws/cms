import { ACCENT } from "../styles";

// 佔比家族的色階:同一個 dither-blue 用遞減透明度做出「同色系深淺」而非撞色
// 調色盤 —— 呼應 dashboard 既有「全站唯一強調色」的規則(styles.ts ACCENT 註解)。
// 超過 6 段落回中性灰,避免無限段落時色階失去可辨識度。
const OPACITIES = [1, 0.75, 0.55, 0.4, 0.28, 0.18];
const OVERFLOW = "rgba(0,0,0,0.12)";

export function segmentColor(index: number): string {
  if (index >= OPACITIES.length) return OVERFLOW;
  const alpha = OPACITIES[index];
  const hex = ACCENT.match(/\d+/g);
  if (!hex) return ACCENT;
  const [r, g, b] = hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
