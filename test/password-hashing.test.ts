import { describe, expect, it } from "vitest";
import {
  PBKDF2_MIN_ITERATIONS,
  createPasswordHashingProfile,
  hashPassword,
  isPasswordHashingProfile,
  isSupportedPasswordHashingIterations,
  passwordHashIterations,
  verifyPassword,
} from "../src/lib/auth";

describe("calibrated password hashing", () => {
  it("writes and verifies a hash at the calibrated count", async () => {
    const profile = await createPasswordHashingProfile(PBKDF2_MIN_ITERATIONS);
    const hash = await hashPassword("calibrated-password", profile);

    expect(passwordHashIterations(hash)).toBe(profile.iterations);
    await expect(verifyPassword("calibrated-password", hash)).resolves.toBe(true);
  });

  it("continues to verify a legacy 600k hash after a later calibration", async () => {
    const legacyProfile = await createPasswordHashingProfile(PBKDF2_MIN_ITERATIONS);
    const legacyHash = await hashPassword("legacy-password", legacyProfile);
    const calibratedProfile = await createPasswordHashingProfile(
      PBKDF2_MIN_ITERATIONS + 25_000,
    );

    expect(calibratedProfile.iterations).toBeGreaterThan(
      legacyProfile.iterations,
    );
    await expect(verifyPassword("legacy-password", legacyHash)).resolves.toBe(true);
  });

  it("keeps the dummy hash at exactly the calibrated work factor", async () => {
    const profile = await createPasswordHashingProfile(
      PBKDF2_MIN_ITERATIONS + 25_000,
    );

    expect(passwordHashIterations(profile.dummyHash)).toBe(profile.iterations);
    expect(isPasswordHashingProfile(profile)).toBe(true);
  });

  it("cannot breach the OWASP floor", async () => {
    const belowFloor = PBKDF2_MIN_ITERATIONS - 1;

    expect(isSupportedPasswordHashingIterations(belowFloor)).toBe(false);
    expect(
      isPasswordHashingProfile({
        iterations: belowFloor,
        dummyHash: "pbkdf2$600000$AA==$AA==",
      }),
    ).toBe(false);
    await expect(createPasswordHashingProfile(belowFloor)).rejects.toThrow(
      "unsupported PBKDF2 iteration count",
    );
  });
});
