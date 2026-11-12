import Link from "next/link";
import { noticeRevealScript, type SiteNoticeWindow } from "@/lib/site-notice";
import { SiteNoticeSync } from "./site-notice-sync";

// 1.56.0:core 公開外框的網站公告(設定 → 網站公告)。頁首上方一行安靜的字:
// 不動、不閃、不跑馬燈。有連結時整行是連結(站內路徑用 next/link,外站開新分頁)。
// 手機上放不下時照常折行,不截斷 —— 公告被切掉一半比多佔一行糟。

/** 公告列的元素 id(inline script 與 SiteNoticeSync 用它找到這一行)。 */
const NOTICE_ID = "site-notice";

// 2.0:公開頁整頁存起來給每個訪客。沒有日期的公告就是一段固定的 HTML。有日期的公告在 HTML 裡先
// hidden,緊接著一段 inline script 在第一個畫面之前照訪客的時鐘拿掉 hidden(noticeRevealScript);
// suppressHydrationWarning:script 改了 hidden,React 接手時不該把它當成不一致。
export function SiteNoticeBar({ notice }: { notice: SiteNoticeWindow }) {
  const scheduled = notice.startsAt !== undefined || notice.endsAt !== undefined;
  return (
    <>
      <p
        id={NOTICE_ID}
        hidden={scheduled || undefined}
        suppressHydrationWarning
        className="border-b border-black/[0.06] bg-black/[0.025] px-4 py-2 text-center text-[13px] leading-relaxed text-balance text-gray-700"
      >
        {notice.href ? <NoticeLink href={notice.href} text={notice.text} /> : notice.text}
      </p>
      {scheduled ? (
        <>
          <script dangerouslySetInnerHTML={{ __html: noticeRevealScript(NOTICE_ID, notice) }} />
          <SiteNoticeSync id={NOTICE_ID} startsAt={notice.startsAt} endsAt={notice.endsAt} />
        </>
      ) : null}
    </>
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
