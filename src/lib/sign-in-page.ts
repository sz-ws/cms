// 1.55.0:網站的登入入口。有啟用的插件宣告 Extension.signInPage(例:會員插件的
// /member/sign-in)就是那一頁;沒有就是後台的 /login。/login 會轉到這裡,所有人從同一個
// 入口登入(登入後的分流見 ./sign-in-continue.ts)。
// @/ext/loader 動態載入:loader → registry → 插件,靜態 import 會繞成循環。

export async function publicSignInPage(): Promise<string | null> {
  const { getExtRuntime } = await import("@/ext/loader");
  const runtime = await getExtRuntime();
  for (const ext of runtime.enabled) {
    if (ext.signInPage) return ext.signInPage;
  }
  return null;
}
