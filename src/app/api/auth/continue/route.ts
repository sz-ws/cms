import { getSessionUser } from "@/lib/auth";
import { signedInDestination } from "@/lib/sign-in-continue";
import { publicSignInPage } from "@/lib/sign-in-page";

// 1.55.0:GET /api/auth/continue?next=&stay= —— 統一登入入口的分流。所有登入方式
// (密碼、Passkey、驗證碼、Google/LINE、Firebase)成功後都導到這裡,依身分送去
// 後台或前台(規則見 lib/sign-in-continue.ts)。只做同站導向,next/stay 都驗過是站內路徑。
// 沒登入(例如 session 剛好過期)就回登入頁。

function absolute(req: Request, path: string): string {
  return new URL(path, req.url).toString();
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const next = url.searchParams.get("next");
  const stay = url.searchParams.get("stay");
  const user = await getSessionUser();
  if (!user) {
    const page = (await publicSignInPage()) ?? "/login";
    return Response.redirect(absolute(req, page), 302);
  }
  // getSessionUser 對自訂角色回 admin/editor;只有一般會員是 guest。
  const staff = user.role !== "guest";
  return Response.redirect(absolute(req, signedInDestination(staff, next, stay)), 302);
}
