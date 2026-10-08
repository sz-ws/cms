import { getSessionUser, type SessionUser } from "@/lib/auth";
import { afterSignInDetour } from "@/ext/after-sign-in";
import { signedInDestination } from "@/lib/sign-in-continue";
import { publicSignInPage } from "@/lib/sign-in-page";

// 1.55.0:GET /api/auth/continue?next=&stay= —— 統一登入入口的分流。所有登入方式
// (密碼、Passkey、驗證碼、Google/LINE、Firebase)成功後都導到這裡,依身分送去
// 後台或前台(規則見 lib/sign-in-continue.ts)。只做同站導向,next/stay 都驗過是站內路徑。
// 沒登入(例如 session 剛好過期)就回登入頁。
//
// 目的地決定好之後,插件可以要會員先走一步(插槽 AfterSignIn,見 ext/after-sign-in.ts;例如帳號上還沒有
// Email 的人先補):去那一步,原本的目的地放在它的 ?next= 上。後台人員不繞路。

function absolute(req: Request, path: string): string {
  return new URL(path, req.url).toString();
}

/**
 * 插件要這個人先走的那一步;沒有就是 null。讀不到插件那一層(runtime 載不起來)也是 null ——
 * 登入照原本的目的地走,不能因為這個卡住。@/ext/loader 動態載入:同 lib/sign-in-page.ts。
 */
async function stepBefore(user: SessionUser, destination: string): Promise<string | null> {
  try {
    const { getExtRuntime } = await import("@/ext/loader");
    return await afterSignInDetour((await getExtRuntime()).slots, user, destination);
  } catch (error) {
    console.error("[auth] the step after sign-in could not be read", error instanceof Error ? error.name : "error");
    return null;
  }
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
  const destination = signedInDestination(staff, next, stay);
  const detour = staff ? null : await stepBefore(user, destination);
  return Response.redirect(absolute(req, detour ?? destination), 302);
}
