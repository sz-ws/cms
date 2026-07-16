"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/I18nProvider";
import { applyEmailDomain } from "@/lib/email-from";

// Email 設定卡的 from-address 後綴提示:掛在 core.emailFrom 欄位下,mount 時問
// /api/email/domains(active provider 的帳號網域)。null / 空陣列 → 整塊不渲染
// (未設 key、provider 不支援、查詢失敗都靜默;提示性功能不許干擾表單)。
// 點 chip 把該網域套進目前輸入值,盡量保留 local part 與 "Name <…>" 包裝。

interface EmailDomainInfo {
  name: string;
  verified: boolean;
}

interface EmailDomainChipsProps {
  value: string;
  onPick: (next: string) => void;
}

export function EmailDomainChips({ value, onPick }: EmailDomainChipsProps) {
  const t = useT();
  const [domains, setDomains] = useState<EmailDomainInfo[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/email/domains", { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ domains?: EmailDomainInfo[] | null }>) : null))
      .then((body) => {
        if (body?.domains?.length) setDomains(body.domains);
      })
      .catch(() => {
        // 提示性功能:失敗即保持不渲染。
      });
    return () => controller.abort();
  }, []);

  if (!domains) return null;

  return (
    <div className="flex flex-col gap-1.5 pt-0.5">
      <span className="text-[11px] font-medium tracking-[0.02em] text-black/35">
        {t("settings.emailDomains.title")}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {domains.map((d) => (
          <button
            key={d.name}
            type="button"
            onClick={() => onPick(applyEmailDomain(value, d.name))}
            title={t("settings.emailDomains.hint")}
            className={
              "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium transition-[background-color,color,box-shadow] duration-150 outline-none focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)] " +
              (d.verified
                ? "text-[rgb(18,124,88)] hover:bg-[rgba(16,145,90,0.16)]"
                : "text-black/45 hover:bg-black/[0.06]")
            }
            style={{
              backgroundColor: d.verified
                ? "rgba(16,145,90,0.10)"
                : "rgba(0,0,0,0.04)",
              boxShadow: d.verified
                ? "inset 0 0 0 1px rgba(16,145,90,0.16)"
                : "inset 0 0 0 1px rgba(0,0,0,0.06)",
            }}
          >
            @{d.name}
            {!d.verified && (
              <span className="text-[10px] font-normal text-black/35">
                {t("settings.emailDomains.unverified")}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
