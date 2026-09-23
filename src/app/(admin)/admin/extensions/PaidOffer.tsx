"use client";

import type { MouseEvent } from "react";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { formatPrice, isEntitled, type RegistryOffer } from "@/lib/registry-offer";
import { cn } from "@/lib/utils";
import { sourceHost, type RegistryEntry } from "./registry-types";

// 1.52.0:付費插件(registry 協定 1)在商店裡的樣子。原則:沒有 offer 的東西逐像素不變;
// 還沒開通的只多一行價格,按鈕換成「聯絡提供者」。不加「付費」標籤、不加鎖頭。
// 價格排版與按鈕文字由 core 決定,registry 只給數字與一句 note(伺服器已驗證、消毒)。
//
// 「聯絡提供者」導向 registry 條目現有的 support 聯絡方式(網址優先,其次 email)。站內
// 申請、外部結帳是之後的階段,這裡不管 offer.action。

type Translator = ReturnType<typeof useT>;

/** 這把金鑰沒開通(locked / requested / expired):不能裝、不能更新。 */
export function isLocked(entry: Pick<RegistryEntry, "access">): boolean {
  return !isEntitled(entry);
}

/** 卡片左側與詳情頁最上面的價格:沒開通、沒裝、也不是從別的來源裝的,而且有東西可顯示。 */
export function showsOffer(entry: RegistryEntry): boolean {
  return (
    isLocked(entry) &&
    !entry.installed &&
    !entry.conflict &&
    (entry.offer?.price !== undefined || entry.offer?.note !== undefined)
  );
}

function periodLabel(t: Translator, period: NonNullable<RegistryOffer["price"]>["period"]): string {
  if (period === "once") return t("registryBrowser.paid.once");
  if (period === "month") return t("registryBrowser.paid.month");
  return t("registryBrowser.paid.year");
}

/** support.url,沒有就 mailto: support.email;都沒有 = null。 */
function contactHref(entry: RegistryEntry): string | null {
  if (entry.supportUrl) return entry.supportUrl;
  if (entry.supportEmail) return `mailto:${entry.supportEmail}`;
  return null;
}

/** 卡片上的一行:`NT$25,000 / 年`;沒有價格就是 note(「依人數報價」)。 */
export function OfferLine({ entry, className }: { entry: RegistryEntry; className?: string }) {
  const t = useT();
  const locale = useLocale();
  const price = entry.offer?.price;
  const text = price
    ? `${formatPrice(price)} ${periodLabel(t, price.period)}`
    : resolveLocalizedString(entry.offer?.note, locale);
  if (!text) return null;
  return <span className={cn("truncate tabular-nums text-ink/50", className)}>{text}</span>;
}

/** 詳情頁側欄最上面:價格稍大、週期小字,下面一行 note。 */
export function OfferBlock({ entry }: { entry: RegistryEntry }) {
  const t = useT();
  const locale = useLocale();
  const price = entry.offer?.price;
  const note = resolveLocalizedString(entry.offer?.note, locale);
  return (
    <div className="flex flex-col gap-1 pb-1">
      {price && (
        <p className="flex items-baseline gap-1.5">
          <span className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-ink/90">
            {formatPrice(price)}
          </span>
          <span className="text-[13px] text-ink/45">{periodLabel(t, price.period)}</span>
        </p>
      )}
      {note && <p className="text-[12.5px] leading-relaxed text-ink/55">{note}</p>}
    </div>
  );
}

const CONTACT_SIZE = {
  sm: "h-8 rounded-full px-3.5 text-[12px] bg-black/[0.06] text-black/70 hover:bg-black/[0.1]",
  md: "h-9 rounded-full px-4 text-[13px] bg-black/[0.06] text-black/70 hover:bg-black/[0.1]",
  lg: "h-10 w-full rounded-[calc(8px*var(--admin-radius-scale,1))] px-4 text-[13px] bg-ink text-white hover:bg-ink/85",
} as const;

/**
 * 「聯絡提供者」:在新分頁開 support 網址(或寄信),不帶後台網址(noreferrer)。
 * 沒有聯絡方式時,卡片寫「尚未開通」,詳情頁寫要請哪個來源開通。
 */
export function ContactProvider({ entry, size }: { entry: RegistryEntry; size: keyof typeof CONTACT_SIZE }) {
  const t = useT();
  const href = contactHref(entry);
  if (!href) {
    return size === "lg" ? (
      <p className="text-[12.5px] leading-relaxed text-ink/60">
        {t("registryBrowser.paid.askProvider", { host: sourceHost(entry.source) })}
      </p>
    ) : (
      <span className="text-[11px] text-ink/50">{t("registryBrowser.paid.notActivated")}</span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // 卡片本身 onClick 會開詳情頁;這顆只開聯絡方式。
      onClick={(e: MouseEvent) => e.stopPropagation()}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-medium transition-[background-color,transform] duration-150 active:scale-[0.96]",
        CONTACT_SIZE[size],
      )}
    >
      {t("registryBrowser.paid.contact")}
    </a>
  );
}
