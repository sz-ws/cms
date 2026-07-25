// [core] 不要在客戶站改這個檔
//
// PBKDF2 的工作因子。這個模組刻意「零 import」,server 與 client 共用。
//
// 為什麼是 100,000 而不是 OWASP 2024 建議的 600,000:
//   Cloudflare Workers 的 WebCrypto(BoringSSL)把 PBKDF2 迭代次數硬限制在
//   100,000,超過直接拋
//     NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported
//   這是**平台常數,不是 CPU 預算** —— 換更貴的 Workers 方案不會改變它。
//   實測於 cms-tmp-suko-test:outcome=ok、cpuTime=10ms,然後拋出上述錯誤。
//
//   曾經有一版把下限設成 600,000,並附一個「部署時校準」精靈,前提是「工作因子
//   取決於這個部署撐得住多少 CPU」。那個前提是錯的:在 Workers 上唯一可能的值
//   就是 100,000,既是下限也是上限。結果是 /setup 永遠建不出第一個管理員,而
//   UI 還會叫人「升級到 CPU 更多的方案」—— 一條永遠走不通的路。
//
//   同一個技術棧的其他站(contest-bat、朝藝麵、suko-admin、emat-hub、my-shop)
//   全部都是 100,000。這裡是唯一走岔的那個。
//
// 怎麼在 100,000 的天花板下仍達到 OWASP 的工作量:**鏈式** derivation。
// 跑 PBKDF2_ROUNDS 輪,每輪 100,000 次,把前一輪的輸出當成下一輪的輸入密碼。
// 每一輪都在平台上限之內,而攻擊者要重現一次猜測仍得付出全部輪數的成本,
// 所以有效工作因子是 ROUNDS × ITERATIONS = 600,000,與 OWASP 2024 一致。
export const PBKDF2_ITERATIONS = 100_000;
export const PBKDF2_ROUNDS = 6;

/** 攻擊者重現一次猜測所需的總迭代次數。只用於顯示與文件,不進 derivation。 */
export const PBKDF2_EFFECTIVE_ITERATIONS = PBKDF2_ITERATIONS * PBKDF2_ROUNDS;

// 平台上限同時也是下限,所以「範圍」退化成單一值。保留這兩個名稱是為了讓既有
// 呼叫端不必同步改動;它們不再表示可調區間。
export const PBKDF2_MIN_ITERATIONS = PBKDF2_ITERATIONS;
export const PBKDF2_MAX_ITERATIONS = PBKDF2_ITERATIONS;

/**
 * 驗證既存 hash 時可接受的迭代次數。上限必須與平台上限一致:若資料庫裡存著更高
 * 的值(例如早期在 Node 上跑 `next dev` 所產生的 600k / 2.4M),拿它去 deriveBits
 * 會在請求中途拋 NotSupportedError,而不是安靜地驗證失敗。這裡先擋掉。
 */
export function isSupportedPasswordHashingIterations(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= PBKDF2_ITERATIONS
  );
}
