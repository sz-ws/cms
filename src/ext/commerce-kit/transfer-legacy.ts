/**
 * @deprecated 1.63.0 — remove in 2.0.
 *
 * 1.63.0 以前,匯款回報的 body 只有 `last5`(帳號末五碼)。現在是 `reference`(格式照付款方式的
 * reportSpec)與 `payerName`。還在送 `last5` 的頁面(舊版快取的結帳頁、別的站的殼)照樣收到,2.0 拿掉。
 */
export function reportedReference(body: { reference?: string; last5?: string }): string | undefined {
  return body.reference ?? body.last5;
}
