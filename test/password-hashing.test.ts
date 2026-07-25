import { describe, expect, it } from "vitest";
import {
  PBKDF2_EFFECTIVE_ITERATIONS,
  PBKDF2_ITERATIONS,
  PBKDF2_ROUNDS,
  getActivePasswordHashingProfile,
  hashPassword,
  isPasswordHashingProfile,
  isSupportedPasswordHashingIterations,
  passwordHashIterations,
  verifyPassword,
} from "../src/lib/auth";

// 這一組測試守的是「在 Cloudflare Workers 上密碼雜湊到底能不能跑」。
// 前一版守的是相反的東西(600k 下限 + 部署時校準),而那個前提在真機上是錯的:
// workerd 的 WebCrypto 把 PBKDF2 硬限制在 100,000/次,拋 NotSupportedError。
// 舊測試全過但產品在 Workers 上完全無法建立管理員 —— 因為測試從沒碰過真的上限。
describe("password hashing on Workers", () => {
  it("每輪的迭代次數不得超過 workerd 的 100,000 上限", () => {
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(100_000);
    // 超過上限的值必須在送進 deriveBits 之前就被擋下,否則是請求中途拋錯。
    expect(isSupportedPasswordHashingIterations(100_001)).toBe(false);
    expect(isSupportedPasswordHashingIterations(600_000)).toBe(false);
    expect(isSupportedPasswordHashingIterations(PBKDF2_ITERATIONS)).toBe(true);
  });

  it("鏈式輪數把有效工作因子拉到 OWASP 的 600k", () => {
    expect(PBKDF2_EFFECTIVE_ITERATIONS).toBe(PBKDF2_ITERATIONS * PBKDF2_ROUNDS);
    expect(PBKDF2_EFFECTIVE_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });

  it("雜湊後可以驗證,且格式自描述", async () => {
    const hash = await hashPassword("correct horse battery staple");

    const parts = hash.split("$");
    expect(parts[0]).toBe("pbkdf2c");
    expect(Number(parts[1])).toBe(PBKDF2_ROUNDS);
    expect(Number(parts[2])).toBe(PBKDF2_ITERATIONS);
    expect(passwordHashIterations(hash)).toBe(PBKDF2_ITERATIONS);

    await expect(
      verifyPassword("correct horse battery staple", hash),
    ).resolves.toBe(true);
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("同一個密碼每次雜湊都不同(salt 有生效)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    await expect(verifyPassword("same-password", b)).resolves.toBe(true);
  });

  it("超過平台上限的既存 hash 回 false,而不是拋錯", async () => {
    // 早期在 Node 上跑 `next dev` 會產生 600k/2.4M 的 hash。送進 workerd 的
    // deriveBits 會拋 NotSupportedError,讓登入請求 500 而不是「密碼不對」。
    const legacy = `pbkdf2$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
    await expect(verifyPassword("anything", legacy)).resolves.toBe(false);
  });

  it("壞掉的格式一律回 false", async () => {
    for (const bad of [
      "",
      "not-a-hash",
      "pbkdf2c$6$100000$0$AA==", // 少一段
      "pbkdf2c$0$100000$0$AA==$AA==", // rounds 不合法
      "pbkdf2c$6$100001$0$AA==$AA==", // 每輪超過上限
    ]) {
      await expect(verifyPassword("x", bad)).resolves.toBe(false);
    }
  });

  it("dummy hash 與實際工作因子一致 —— 否則回應時間就是帳號列舉 oracle", async () => {
    const profile = await getActivePasswordHashingProfile();

    expect(profile.iterations).toBe(PBKDF2_ITERATIONS);
    expect(passwordHashIterations(profile.dummyHash)).toBe(profile.iterations);
    expect(isPasswordHashingProfile(profile)).toBe(true);

    // dummy 必須走完整條 derivation(才會付出等量成本),所以它得是可解析的
    // 鏈式格式、輪數與正式雜湊相同。
    const parts = profile.dummyHash.split("$");
    expect(parts[0]).toBe("pbkdf2c");
    expect(Number(parts[1])).toBe(PBKDF2_ROUNDS);
  });
});
