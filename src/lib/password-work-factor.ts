// [core] 不要在客戶站改這個檔
//
// PBKDF2 工作因子的政策界線。這個模組刻意「零 import」：校準精靈是 client
// component，若它為了兩個常數而 import `@/lib/auth`，就會把 `next/headers`
// 拉進 client bundle，整個 /setup 會在編譯期 500。界線本身是政策而非實作，
// 所以放在這裡供 server 與 client 共用。

// OWASP 對 PBKDF2-HMAC-SHA256 的現行建議下限。不能為了讓 Free plan 跑得動而
// 偷降；若這個值在部署端無法存活，該方案就不適合承載 password login。
export const PBKDF2_MIN_ITERATIONS = 600_000;

// 校準上限是明確的政策界線，不把「找最高可存活值」變成無上限的 CPU / 帳單探測。
// 四倍 OWASP 基線已足以涵蓋目前 paid Workers 的常見配置；碰到它時 UI 會明說。
export const PBKDF2_MAX_ITERATIONS = 2_400_000;

export function isSupportedPasswordHashingIterations(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= PBKDF2_MIN_ITERATIONS &&
    value <= PBKDF2_MAX_ITERATIONS
  );
}
