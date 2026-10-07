// 站內路徑的檢查。插件或站台給一個「連去哪」的值(插槽、設定)時,畫連結之前先過這裡:
// / 開頭、不是 //,也沒有反斜線或控制字元 —— 瀏覽器會把 /\ 當成 //,換行與 tab 會被拿掉,都可能連到站外。

const SITE_PATH = /^\/(?!\/)[^\\\u0000-\u001f\u007f]*$/;

export function isSitePath(href: unknown): href is string {
  return typeof href === "string" && SITE_PATH.test(href);
}
