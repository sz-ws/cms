import { getSessionUser } from "@/lib/auth";
import type { Locale } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { accountEntriesFor } from "@/ext/account-entries";
import { getExtRuntime } from "@/ext/loader";

// 2.x:GET /api/account/entries?locale=<locale> → { entries: [{ key, href, label, note }] }
// 登入的人的「我的帳戶」項目(插槽 AccountEntries,src/ext/account-entries.ts),跟 accountEntriesFor() 一樣:
// 照插件填的先後,狀態是 null 的不列,label 與 note 用 locale 那個語言。給存起來的公開頁用 —— 頁面本身對每個訪客
// 都一樣,畫面出現之後瀏覽器才問這個人有哪些項目(src/ext/META.md「Public pages」第 3 點)。
//
// locale:網站的語言之一(lib/i18n 的 Locale);沒帶就是網站預設的(core.locale);不認得的是 400,不悄悄換成別的。
// 沒登入是 401,形狀同 authErrorResponse(lib/auth.ts)。任何登入的人都可以問(一般會員也是:這是他自己的帳戶)。
// GET 沒有狀態變更,不需要 assertSameOrigin;回應因人而異,不進任何快取。

const NO_STORE = { "Cache-Control": "private, no-store" };
const LOCALES: readonly Locale[] = ["en", "zh-Hant"];

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export async function GET(req: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const asked = new URL(req.url).searchParams.get("locale");
  if (asked !== null && !isLocale(asked)) return Response.json({ error: "invalid_locale" }, { status: 400, headers: NO_STORE });
  const locale = asked ?? (await getLocale());

  const rt = await getExtRuntime();
  const entries = await accountEntriesFor(rt.slots, { id: user.id, role: user.role }, locale);
  return Response.json({ entries }, { headers: NO_STORE });
}
