import { describe, expect, it, vi } from "vitest";

// pepper 取自 getEnv().AUTH_PEPPER。測試環境沒有真的 Cloudflare request context
// (getCloudflareContext() 與 cloudflare:test 的 env 不是同一個物件),所以直接
// 把 @/lib/cf 換掉,才控制得住這個變數。auth.ts 只用到 getEnv,不碰其他。
const fakeEnv = vi.hoisted(() => ({ value: {} as { AUTH_PEPPER?: string } }));
vi.mock("@/lib/cf", () => ({
  getEnv: () => fakeEnv.value,
}));
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


  // ── pepper 的相容性 ──────────────────────────────────────────────
  //
  // 這一組守的是一個實際存在過的陷阱:pepper 有實作,但部署流程從來沒設定過
  // AUTH_PEPPER,所以現實中每個站台的密碼都是無 pepper 的。當時 verify 的規則是
  // 「hash 的旗標與現在的 env 不符就 false」,於是任何人想事後補上 pepper,
  // 全站立刻登不進去、且沒有遷移路徑 —— 等於這個功能永遠不能被啟用。
  //
  // 現在的規則是「照 hash 裡記的旗標驗證」。四種組合都要有守門。
  describe("pepper 的存在與否", () => {
    async function withPepper<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
      const before = fakeEnv.value;
      fakeEnv.value = value === undefined ? {} : { AUTH_PEPPER: value };
      try {
        return await fn();
      } finally {
        fakeEnv.value = before;
      }
    }

    it("設了 pepper 之後,雜湊會記下旗標,且只有同一把 pepper 驗得過", async () => {
      const hash = await withPepper("pepper-a", () => hashPassword("hunter2"));
      expect(hash.split("$")[3]).toBe("1");

      await withPepper("pepper-a", async () => {
        await expect(verifyPassword("hunter2", hash)).resolves.toBe(true);
        await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
      });
      // 換一把 pepper = 算出來的東西完全不同 → 驗不過(而不是意外通過)。
      await withPepper("pepper-b", async () => {
        await expect(verifyPassword("hunter2", hash)).resolves.toBe(false);
      });
    });

    it("沒有 pepper 時產生的雜湊,旗標是 0", async () => {
      const hash = await withPepper(undefined, () => hashPassword("hunter2"));
      expect(hash.split("$")[3]).toBe("0");
      await withPepper(undefined, async () => {
        await expect(verifyPassword("hunter2", hash)).resolves.toBe(true);
      });
    });

    // 這一條是整組的重點:事後補上 pepper 不可以把既有使用者鎖在門外。
    it("事後才補上 AUTH_PEPPER:既有的無 pepper 密碼仍然登得進去", async () => {
      const hash = await withPepper(undefined, () => hashPassword("hunter2"));
      await withPepper("pepper-added-later", async () => {
        await expect(verifyPassword("hunter2", hash)).resolves.toBe(true);
        await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
      });
    });

    // 反方向沒有放寬:pepper 一旦用過就不能拔掉,因為那些雜湊算不出來。
    it("拔掉 AUTH_PEPPER:用過 pepper 的密碼一律 false,而不是拋錯", async () => {
      const hash = await withPepper("pepper-a", () => hashPassword("hunter2"));
      await withPepper(undefined, async () => {
        await expect(verifyPassword("hunter2", hash)).resolves.toBe(false);
      });
    });
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
