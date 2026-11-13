import { SiteNoticeBar } from "@/app/(public)/site-notice";
import type { PublicFrameProps } from "@/ext/public-pages";
import { PathFrame } from "./path-frame";

// The fill (a server component): fill(PublicFrame, { replace: SiteFrame }). It renders the notice on the server and
// hands it to the client frame as an element.
export function SiteFrame({ notice, children }: PublicFrameProps) {
  return <PathFrame notice={notice ? <SiteNoticeBar notice={notice} /> : null}>{children}</PathFrame>;
}
