// Next 用「丟一個帶 digest 的例外」來換頁、回 404、改成在瀏覽器畫:redirect()、notFound()、forbidden()、
// unauthorized() 與幾種 bailout。接住錯誤的地方(插槽的 boundary、伺服器端包住填法的那一層)要認得它們,
// 原樣往上丟給 Next,不能當成「畫壞了」吃掉。
//
// 照 digest 的開頭認(next/dist/client/components 的 redirect-error、http-access-fallback、bailout-to-csr、
// hooks-server-context);包在別的錯誤裡(error.cause)的也算。不用 next/navigation 的 unstable_rethrow:
// 這個檔 client 與伺服器都會載入,測試裡 next/navigation 常被整包換掉。
//
// 2.x:存起來的頁面(dynamic = "error")在渲染時讀了 cookies()、headers()、searchParams,Next 丟的是沒有
// digest、帶 code "NEXT_STATIC_GEN_BAILOUT" 的錯誤(next/dist/client/components/static-generation-bailout)。
// 它也要原樣往上丟:吃掉的話,填的元件會悄悄換成預設內容、被存起來,誤用就沒有人看得到。

const NEXT_SIGNALS = ["NEXT_REDIRECT", "NEXT_HTTP_ERROR_FALLBACK", "BAILOUT_TO_CLIENT_SIDE_RENDERING", "DYNAMIC_SERVER_USAGE"];
const STATIC_GEN_BAILOUT = "NEXT_STATIC_GEN_BAILOUT";

/** 這個例外是 Next 自己的控制流程(不是程式壞掉)。 */
export function isNextSignal(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 5) return false;
  const { digest, code, cause } = error as { digest?: unknown; code?: unknown; cause?: unknown };
  if (typeof digest === "string" && NEXT_SIGNALS.some((signal) => digest.startsWith(signal))) return true;
  if (code === STATIC_GEN_BAILOUT) return true;
  return isNextSignal(cause, depth + 1);
}
