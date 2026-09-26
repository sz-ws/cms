import Link from "next/link";
import type { SiteNotice } from "@/lib/site-notice";

// 1.56.0:core 公開外框的網站公告(設定 → 網站公告)。頁首上方一行安靜的字:
// 不動、不閃、不跑馬燈。有連結時整行是連結(站內路徑用 next/link,外站開新分頁)。
// 手機上放不下時照常折行,不截斷 —— 公告被切掉一半比多佔一行糟。

export function SiteNoticeBar({ notice }: { notice: SiteNotice }) {
  return (
    <p className="border-b border-black/[0.06] bg-black/[0.025] px-4 py-2 text-center text-[13px] leading-relaxed text-balance text-gray-700">
      {notice.href ? <NoticeLink href={notice.href} text={notice.text} /> : notice.text}
    </p>
  );
}

function NoticeLink({ href, text }: { href: string; text: string }) {
  const className =
    "underline decoration-black/20 underline-offset-4 transition-colors hover:text-gray-950 hover:decoration-black/50";
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={className}>
        {text}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {text}
    </a>
  );
}
