import { ensureReporting, reportAndFlush } from "@/lib/observe/report";

// 「送一筆測試事件」的 handler(POST /api/ext/sentry/test-event)。
//
// 為什麼這顆按鈕值得存在:錯誤回報是少數幾種「設定錯了完全沒有症狀」的功能 ——
// DSN 打錯一個字、GlitchTip 的專案刪掉了、Worker 出不去外網,結果都一樣:什麼事都
// 沒發生。而你會等到真的出事、翻遍收集端卻一片空白的那一天才知道。
//
// 所以這裡走的是**完整的真實路徑**:同一個 ensureReporting、同一個 client、同一組
// 清理規則、同一個 flush。刻意不做「只驗證 DSN 格式」那種假測試 —— 那只證明了
// 字串長得像 DSN。
//
// SDK 一律經由 core 的 @/lib/observe/report 使用,這個檔案不直接 import
// @sentry/nextjs:extensions/registry.ts 是 src/ext/loader.ts 的靜態相依,任何從這裡
// 長出去的 import 都會變成整個 extension 系統的靜態相依鏈的一部分。
//
// 認證由 core 的 dispatch 負責(src/app/api/ext/[extId]/[[...path]]/route.ts):
// 這條路不是 public content type,所以 requireAuth(編輯者以上)+ 同源檢查都會先跑過。

export interface TestEventResult {
  ok: boolean;
  /** 送出去了就有;GlitchTip 上可以直接用這個 id 找。 */
  eventId?: string;
  /** ok:false 時的原因,由前端翻成人話。 */
  reason?: "not_sending" | "capture_failed";
  layer: string;
  origin?: string;
  source: string;
}

export async function testEventHandler(): Promise<Response> {
  const status = await ensureReporting();
  const base = {
    layer: status.layer,
    origin: status.origin,
    source: status.source,
  };

  // 沒在送就直說,不要假裝成功。這是整顆按鈕的價值所在:把「有設定」和「真的會送」
  // 這兩件很容易被混為一談的事分開。
  if (!status.sending) {
    return Response.json({ ...base, ok: false, reason: "not_sending" });
  }

  try {
    const eventId = await reportAndFlush(
      // 訊息刻意寫得一眼就知道是人按出來的 —— 半年後有人在 GlitchTip 上看到它,
      // 不該花任何時間去查「這是什麼壞了」。
      new Error("Test event from the CMS admin (error tracking settings page)"),
      { path: "admin-test-event", layer: status.layer },
    );
    if (!eventId) {
      // ensureReporting 說會送、reportAndFlush 卻沒送 —— 兩次判定之間狀態變了
      // (極罕見)。當成失敗處理,不要回一個沒有 id 的「成功」。
      return Response.json({ ...base, ok: false, reason: "not_sending" });
    }
    return Response.json({ ...base, ok: true, eventId });
  } catch (e) {
    console.error("[observe] test event failed", e);
    return Response.json({ ...base, ok: false, reason: "capture_failed" });
  }
}
