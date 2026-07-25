"use client";

import { useState } from "react";
import { Gauge, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/legacy";
import {
  PBKDF2_MAX_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
} from "@/lib/auth";
import { useT } from "@/lib/i18n/I18nProvider";

const CALIBRATION_GRANULARITY = 25_000;

type ProbeResult = "survived" | "exceeded";
type CalibrationResult = {
  iterations: number;
  reachedCeiling: boolean;
};

function roundDownToGranularity(value: number): number {
  return Math.floor(value / CALIBRATION_GRANULARITY) * CALIBRATION_GRANULARITY;
}

/**
 * 只有成功 JSON 才是「存活」。Cloudflare 1102 的 HTML/error response 代表 candidate
 * 沒有通過；可辨識的 JSON 錯誤則不是 CPU 訊號，必須顯示失敗而非錯把它當較低上限。
 */
async function requestCalibration(
  iterations: number,
  commit = false,
): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch("/api/auth/password-work-factor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ iterations, commit }),
    });
  } catch (error) {
    throw new Error("The calibration request did not complete.", { cause: error });
  }

  if (response.ok) {
    const body = (await response.json()) as { iterations?: unknown; ok?: unknown };
    if (body.ok === true && body.iterations === iterations) return "survived";
    throw new Error("The calibration response was incomplete.");
  }

  if (response.headers.get("content-type")?.includes("application/json")) {
    const body = (await response.json()) as { error?: unknown };
    throw new Error(
      typeof body.error === "string" ? body.error : "The calibration request failed.",
    );
  }

  return "exceeded";
}

async function findHighestSurvivingWorkFactor(): Promise<CalibrationResult | null> {
  if ((await requestCalibration(PBKDF2_MIN_ITERATIONS)) === "exceeded") return null;

  let low = PBKDF2_MIN_ITERATIONS;
  let high = Math.min(PBKDF2_MAX_ITERATIONS, low * 2);
  while (high > low && (await requestCalibration(high)) === "survived") {
    low = high;
    if (low === PBKDF2_MAX_ITERATIONS) {
      return { iterations: low, reachedCeiling: true };
    }
    high = Math.min(PBKDF2_MAX_ITERATIONS, high * 2);
  }

  // high 是第一個未存活的 candidate；在可見、有限的 25k 格點二分，避免把
  // 校準做成大量昂貴請求。成功 probe 不改設定，最後才 commit 最佳值。
  while (high - low > CALIBRATION_GRANULARITY) {
    const middle = roundDownToGranularity((low + high) / 2);
    if (middle <= low) break;
    if ((await requestCalibration(middle)) === "survived") low = middle;
    else high = middle;
  }
  return { iterations: low, reachedCeiling: false };
}

interface PasswordWorkFactorWizardProps {
  initialIterations: number | null;
  onCalibrated?: (iterations: number) => void;
}

/** setup 與已登入 admin 共用；不依賴 Worker 內不可靠的同步時鐘。 */
export function PasswordWorkFactorWizard({
  initialIterations,
  onCalibrated,
}: PasswordWorkFactorWizardProps) {
  const t = useT();
  const [iterations, setIterations] = useState(initialIterations);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"incompatible" | "failed" | null>(null);
  const [reachedCeiling, setReachedCeiling] = useState(false);
  const [loweringCandidate, setLoweringCandidate] =
    useState<CalibrationResult | null>(null);

  async function commit(result: CalibrationResult) {
    if ((await requestCalibration(result.iterations, true)) === "exceeded") {
      throw new Error("The final calibration request exceeded the CPU limit.");
    }
    setIterations(result.iterations);
    setReachedCeiling(result.reachedCeiling);
    setLoweringCandidate(null);
    onCalibrated?.(result.iterations);
  }

  function reportFailure(calibrationError: unknown) {
    console.error("[password-work-factor] calibration failed", calibrationError);
    setError("failed");
  }

  async function calibrate() {
    setPending(true);
    setError(null);
    setReachedCeiling(false);
    setLoweringCandidate(null);
    try {
      const result = await findHighestSurvivingWorkFactor();
      if (!result) {
        setIterations(null);
        setError("incompatible");
        return;
      }
      if (iterations !== null && result.iterations < iterations) {
        // 方案遷移可能需要降低；先明示舊/新值，不能把較弱設定直接寫掉。
        setLoweringCandidate(result);
        return;
      }
      await commit(result);
    } catch (calibrationError) {
      reportFailure(calibrationError);
    } finally {
      setPending(false);
    }
  }

  async function confirmLowering() {
    if (!loweringCandidate) return;
    setPending(true);
    setError(null);
    try {
      await commit(loweringCandidate);
    } catch (calibrationError) {
      reportFailure(calibrationError);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        {iterations === null ? (
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-black/55" aria-hidden />
        ) : (
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[rgb(86,114,228)]" aria-hidden />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-black/90">
            {t("authCalibration.title")}
          </h3>
          <p className="text-[12px] leading-relaxed text-black/40">
            {t("authCalibration.description")}
          </p>
        </div>
      </div>

      <div className="rounded-[8px] bg-black/[0.03] px-3 py-2.5 text-[12px] leading-relaxed text-black/55 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
        {iterations === null
          ? t("authCalibration.notCalibrated")
          : t("authCalibration.current", { iterations })}
      </div>

      {reachedCeiling && (
        <p className="text-[12px] leading-relaxed text-black/40">
          {t("authCalibration.ceiling", { iterations: PBKDF2_MAX_ITERATIONS })}
        </p>
      )}
      {error === "incompatible" && (
        <p className="rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2.5 text-[12px] leading-relaxed text-red-700">
          {t("authCalibration.incompatible", { iterations: PBKDF2_MIN_ITERATIONS })}
        </p>
      )}
      {error === "failed" && (
        <p className="rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2.5 text-[12px] leading-relaxed text-red-700">
          {t("authCalibration.failed")}
        </p>
      )}
      {loweringCandidate && iterations !== null && (
        <div className="rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2.5 text-[12px] leading-relaxed text-red-700">
          <p>
            {t("authCalibration.loweringWarning", {
              current: iterations,
              next: loweringCandidate.iterations,
            })}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setLoweringCandidate(null)}
              className="rounded-[8px] px-3 py-1.5 font-medium text-red-700 transition-colors hover:bg-red-600/10"
            >
              {t("authCalibration.keepCurrent")}
            </button>
            <button
              type="button"
              onClick={confirmLowering}
              disabled={pending}
              className="rounded-[8px] bg-red-700 px-3 py-1.5 font-medium text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("authCalibration.applyLowering")}
            </button>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="button" disabled={pending} onClick={calibrate}>
          <Gauge className="size-4" aria-hidden />
          {pending
            ? t("authCalibration.calibrating")
            : iterations === null
              ? t("authCalibration.start")
              : t("authCalibration.recalibrate")}
        </Button>
      </div>
    </div>
  );
}
