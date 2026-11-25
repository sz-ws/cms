"use client";

// ─────────────────────────────────────────────────────────────────────────────
// [core] 不要在客戶站改這個檔。畫面在 ./site-error.tsx(那個是你的)。
//
// 整個網站最後一道錯誤邊界:根 layout 底下沒有別的 error.tsx 接住的錯,都到這裡。沒有這個檔時,Next 會畫它
// 內建的英文錯誤頁(「This page couldn't load」),而且不分錯誤種類。
//
// 最常見的一種不是 bug,是**部署**:瀏覽器手上是上一版的 HTML,裡面指向上一版的 chunk 檔名,新版上線之後
// 那些檔案已經不在了(404)→ ChunkLoadError。實際踩到的(2026-11-25,一個正式站):公開頁的 HTML 回
// `Cache-Control: s-maxage=…, stale-while-revalidate=…`,沒有 max-age —— 瀏覽器把它當成已過期、但在
// stale-while-revalidate 的期間內,iOS 的瀏覽器(WebKit)於是先拿快取裡的舊 HTML 給人看、背景再去更新
// (從 Workers Logs 的先後推斷:舊 chunk 的請求比那次 document 請求還早)。從 Google 點進首頁的 iOS Chrome
// 拿到上一次部署之前那份,頁面的 chunk 404,整頁變成英文錯誤頁;按一次重新整理就好了。
//
// 所以這種錯自動重新整理一次。lib/chunk-reload.ts 記住「這個網址剛剛重新整理過」(sessionStorage,60 秒),
// 同一個網址重新整理之後還是要不到 chunk,就不再重來,改畫錯誤畫面 —— 不會變成無限重新整理。記不住
// (sessionStorage 不能用)的時候也不自動重來。其他錯誤照樣畫錯誤畫面,讓人自己重新整理或回首頁。
//
// 錯誤本身照樣會被回報:Next 在交給錯誤邊界之前就 console.error 過了,有設前端 DSN 時
// instrumentation-client.ts 的 SDK 會收到。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { claimChunkReload, isChunkLoadError } from "@/lib/chunk-reload";
import { SITE_ERROR_LANG, SiteError } from "./site-error";

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** 要不到 chunk 的錯:自動重新整理一次。回傳是不是正在重新整理(畫面據此顯示「載入中」而不是錯誤)。 */
function useChunkReload(error: unknown): boolean {
  const chunk = isChunkLoadError(error);
  const [reloading, setReloading] = useState(chunk);
  useEffect(() => {
    if (!chunk) return;
    const { pathname, search } = window.location;
    if (claimChunkReload(sessionStore(), pathname + search, Date.now())) window.location.reload();
    // 讀的是外部狀態(sessionStorage 記的上一次重新整理),只能在瀏覽器上、畫完之後讀;這一次 setState 就是規則說的例外。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else setReloading(false);
  }, [chunk]);
  return reloading;
}

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const reloading = useChunkReload(error);
  return (
    <html lang={SITE_ERROR_LANG}>
      <body style={{ margin: 0 }}>
        <SiteError reloading={reloading} reload={() => window.location.reload()} />
      </body>
    </html>
  );
}
