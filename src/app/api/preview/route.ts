import { draftMode } from "next/headers";
import { authErrorResponse, requireAuth } from "@/lib/auth";
import { previewPath } from "@/lib/preview";

// [core] 2.0 草稿預覽。公開頁整頁存起來給每個訪客(見 (public)/[[...slug]]/page.tsx),只有已發佈的
// 內容。編輯要看草稿,走 Next 的 draft mode:這裡給登入的編輯一個 draft mode cookie,轉到那一頁。
// 帶著那個 cookie 的請求 OpenNext 不從快取回應、Next 逐請求渲染,渲染出來的不會存起來;
// DetailView 看到 draftMode 就連草稿一起讀。
//
//   GET /api/preview?path=/blog/hello          開(要登入,editor 以上)
//   GET /api/preview?exit=1&path=/blog/hello   關(誰都可以關自己的)
//
// GET 而不是 POST:這是「打開一個網址」,從後台的連結點過來就好;它不改任何資料,只設自己的 cookie。

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = previewPath(url.searchParams.get("path"));
  const exit = url.searchParams.get("exit") === "1";
  if (!exit && path === null) return Response.json({ error: "invalid_path" }, { status: 400 });

  if (!exit) {
    try {
      await requireAuth("editor");
    } catch (e) {
      const res = authErrorResponse(e);
      if (res) return res;
      throw e;
    }
  }

  const draft = await draftMode();
  if (exit) draft.disable();
  else draft.enable();

  return new Response(null, {
    status: 307,
    headers: { location: new URL(path ?? "/", url).toString(), "cache-control": "private, no-store" },
  });
}
