"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";
import { resolveLocalizedString, type LocalizedString } from "@/lib/i18n/localized";

// 1.56.0:上新通知的彈窗。只在預設的管理員打開後台時掛上(admin/layout.tsx),問一次
// GET /api/registry/notice;有就跳一則。
//
// 樣子照設計文件:插件 banner(沒有就不放)、來源主機小字、標題、內文、知道了 / 查看。
// 任何關閉方式(知道了、查看、Esc、點背景)都算看過。沒有「不再顯示」、沒有倒數、
// 沒有側欄紅點,也不做閃爍或呼吸效果。

interface NoticeView {
  source: string;
  id: string;
  title: LocalizedString;
  body?: LocalizedString;
  extension: string;
  banner?: string;
  version: string;
}

function isNoticeView(value: unknown): value is NoticeView {
  if (!value || typeof value !== "object") return false;
  const n = value as Record<string, unknown>;
  return (
    typeof n.source === "string" &&
    typeof n.id === "string" &&
    typeof n.extension === "string" &&
    typeof n.version === "string" &&
    n.title !== undefined
  );
}

function hostOf(source: string): string {
  try {
    return new URL(source).host;
  } catch {
    return source;
  }
}

function bannerUrl(notice: NoticeView): string | null {
  if (!notice.banner) return null;
  const params = new URLSearchParams({
    source: notice.source,
    id: notice.extension,
    file: notice.banner,
    v: notice.version,
  });
  return `/api/registry/asset?${params.toString()}`;
}

function detailHref(notice: NoticeView): string {
  const params = new URLSearchParams({ tab: "browse", source: notice.source, ext: notice.extension });
  return `/admin/extensions?${params.toString()}`;
}

function markSeen(notice: NoticeView): void {
  void fetch("/api/registry/notice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: notice.source, id: notice.id }),
    keepalive: true,
  }).catch(() => {
    // 沒記到的話下次進後台會再跳一次,不影響現在的畫面。
  });
}

export function RegistryNoticeDialog() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [notice, setNotice] = useState<NoticeView | null>(null);
  const [bannerFailed, setBannerFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/registry/notice")
      .then((res) => (res.ok ? (res.json() as Promise<{ notice?: unknown }>) : null))
      .then((body) => {
        if (!cancelled && isNoticeView(body?.notice)) setNotice(body.notice);
      })
      .catch(() => {
        // 讀不到就不跳,後台照常。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!notice) return null;

  const close = (view: boolean) => {
    markSeen(notice);
    setNotice(null);
    if (view) router.push(detailHref(notice));
  };
  const title = resolveLocalizedString(notice.title, locale) ?? "";
  const body = resolveLocalizedString(notice.body, locale);
  const banner = bannerFailed ? null : bannerUrl(notice);

  return (
    <Dialog open onOpenChange={(next) => !next && close(false)}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md gap-0 overflow-hidden rounded-[calc(20px*var(--admin-radius-scale,1))] p-0"
      >
        {banner && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={banner}
            alt=""
            className="aspect-[5/2] w-full object-cover"
            onError={() => setBannerFailed(true)}
          />
        )}
        <div className="flex flex-col gap-1.5 p-5">
          <span className="text-[11px] text-ink/45">{hostOf(notice.source)}</span>
          <DialogTitle className="text-[16px] font-semibold leading-snug tracking-[-0.01em] text-ink/90">
            {title}
          </DialogTitle>
          {body && (
            <DialogDescription className="text-[13px] leading-relaxed text-ink/65">{body}</DialogDescription>
          )}
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => close(false)}>
              {t("registryNotice.dismiss")}
            </Button>
            <Button onClick={() => close(true)}>{t("registryNotice.view")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
