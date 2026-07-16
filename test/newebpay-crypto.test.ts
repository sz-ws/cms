import { describe, it, expect } from "vitest";
import {
  encryptTradeInfo,
  decryptTradeInfo,
  tradeSha,
} from "../extensions/newebpay/crypto";
import {
  timingSafeEqual,
  hexToBytes,
  bytesToHex,
} from "../src/ext/payment-kit/util";

// 藍新 MPG 加解密原語的單元測試。無官方 test vector 可引用(手冊只給 PHP 範例
// 程式),以 roundtrip + 形狀 + 確定性驗證;與藍新的實際相容性由測試機交易驗收。

const KEY = "abcdefghijklmnopqrstuvwxyz123456"; // 32 chars
const IV = "1234567890123456"; // 16 chars

describe("newebpay crypto — AES-256-CBC TradeInfo", () => {
  it("encrypt → decrypt roundtrips (querystring payload)", async () => {
    const plain =
      "MerchantID=MS123&RespondType=JSON&TimeStamp=1752600000&Version=2.0&MerchantOrderNo=SKTEST1&Amt=100&ItemDesc=%E6%B8%AC%E8%A9%A6";
    const hex = await encryptTradeInfo(plain, KEY, IV);
    expect(hex).toMatch(/^[0-9a-f]+$/); // lowercase hex
    expect(hex.length % 32).toBe(0); // AES block(16 bytes = 32 hex chars)對齊
    expect(await decryptTradeInfo(hex, KEY, IV)).toBe(plain);
  });

  it("roundtrips multibyte UTF-8 (中文 ItemDesc)", async () => {
    const plain = "ItemDesc=測試訂單——藍新金流&Amt=1";
    const hex = await encryptTradeInfo(plain, KEY, IV);
    expect(await decryptTradeInfo(hex, KEY, IV)).toBe(plain);
  });

  it("decrypt with wrong key/iv or garbage returns null (never throws)", async () => {
    const hex = await encryptTradeInfo("a=1", KEY, IV);
    expect(
      await decryptTradeInfo(hex, "wrongwrongwrongwrongwrongwrong12", IV),
    ).toBeNull();
    expect(await decryptTradeInfo("zz-not-hex", KEY, IV)).toBeNull();
    expect(await decryptTradeInfo("abcd", KEY, IV)).toBeNull(); // 非 block 對齊
  });

  it("rejects malformed HashKey/HashIV lengths loudly", async () => {
    await expect(encryptTradeInfo("a=1", "short", IV)).rejects.toThrow(
      /HashKey/,
    );
    await expect(encryptTradeInfo("a=1", KEY, "short")).rejects.toThrow(
      /HashKey/,
    );
  });
});

describe("newebpay crypto — TradeSha", () => {
  it("is deterministic, 64-char uppercase hex, keyed on all three inputs", async () => {
    const info = await encryptTradeInfo("a=1&b=2", KEY, IV);
    const sha1 = await tradeSha(info, KEY, IV);
    const sha2 = await tradeSha(info, KEY, IV);
    expect(sha1).toBe(sha2);
    expect(sha1).toMatch(/^[0-9A-F]{64}$/);
    // 改任一輸入 → 不同 digest。
    expect(await tradeSha(`${info}00`, KEY, IV)).not.toBe(sha1);
    expect(
      await tradeSha(info, "abcdefghijklmnopqrstuvwxyz654321", IV),
    ).not.toBe(sha1);
  });
});

describe("newebpay crypto — helpers", () => {
  it("timingSafeEqual: equal / unequal / different length", () => {
    expect(timingSafeEqual("ABCDEF", "ABCDEF")).toBe(true);
    expect(timingSafeEqual("ABCDEF", "ABCDEE")).toBe(false);
    expect(timingSafeEqual("ABC", "ABCD")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("hexToBytes ↔ bytesToHex roundtrip; invalid hex → null", () => {
    const bytes = hexToBytes("00ff10ab");
    expect(bytes).not.toBeNull();
    expect(bytesToHex(bytes as Uint8Array)).toBe("00ff10ab");
    expect(hexToBytes("0g")).toBeNull();
    expect(hexToBytes("abc")).toBeNull(); // 奇數長度
    expect(hexToBytes("")).toBeNull();
  });
});
