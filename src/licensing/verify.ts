import type { LicenseCheckResult, LicenseVerifier } from "./types";

// Community edition 預設實作:恆真、零 telemetry、零外呼。這是這個 repo 的
// git 歷史裡永遠會存在的版本 —— open-source 使用者 clone 這個 repo,
// `verify.local.ts` 不存在(gitignored),build 前的 predev/prebuild script
// (scripts/ensure-licensing-stub.mjs)會自動產生一份指向這裡的 stub,
// 所以 open-source build 永遠拿到這個實作,不會因為缺一個檔案而炸掉。
export const communityVerify: LicenseVerifier = {
  async checkIn(): Promise<LicenseCheckResult> {
    return {
      ok: true,
      tier: "community",
      telemetrySent: false,
      detail: "Community edition — no license verification configured.",
    };
  },
};
