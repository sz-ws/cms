// 1.39.0:admin 側欄 icon 欄位的形狀判斷。獨立成零依賴的一檔,因為 client 端的
// sidebar 也要用 —— ./admin-menu.ts 會拉進 zod 與 svg-guard,不該進每一頁 admin 的 bundle。

/** 以 `<` 開頭(忽略前導空白)的 icon 視為內嵌 SVG,其餘是圖示代號。 */
export function isInlineSvgIcon(icon: string): boolean {
  return icon.trimStart().startsWith("<");
}
