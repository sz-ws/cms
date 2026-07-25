// 收件語意(submission semantics)的**純判定層**:一個 content type 到底是「內容」
// 還是「別人寄給你的訊息」。這裡不碰 DB、不碰 React,只回答分類問題 —— 因為同一個
// 問題有三個彼此獨立的消費端,而它們手上的 manifest 形狀不一樣:
//
//   1. dx/interpret.tsx      拿到已 parse 的 DeclarativeManifest(決定 admin 用哪個
//                            surface、public route 要不要生成)。
//   2. dx/crud.ts            拿到單一 DeclarativeContentType(決定路由集合)。
//   3. /api/content/…/route  直接 JSON.parse 資料庫裡的 manifest 字串,型別是鬆散的
//                            StoredManifest —— 它**不**經過 zod,故不能依賴 parse 後的
//                            型別。這也正是本檔的參數型別刻意寫成「最小結構」的原因:
//                            嚴格的 DeclarativeManifest 與鬆散的 StoredManifest 都能餵
//                            進同一個函式,兩條路徑的判定永遠不會分叉。
//
// 判定分叉 = 隱私事故。公開 API 若對「什麼是收件匣型別」的認知與 interpret 不同,
// 就會出現「admin 當它是私人訊息、API 當它是可公開內容」的縫。所以只有這一份實作。
//
// ── 分類規則 ────────────────────────────────────────────────────────────────
//   a. 明寫 kind:"submission" → submission(1.21.0 起的正式宣告方式)。
//   b. 明寫 kind:"content"    → content(讓作者能明確退出下面的推論)。
//   c. 沒寫 kind:推論 —— `public:true`(匿名可 POST 建立)且**整份 manifest 沒有
//      任何 list/detail public route 指向它** → submission。
//
// (c) 是向後相容的核心:1.21.0 之前寫的 manifest(如 registry 的 contact)一個字都
// 不用改就自動取得收件匣語意。這個推論刻意收得很緊 —— 「匿名可以寫、但沒有任何公開
// 頁面可以讀」在語意上只有一種可能:那些列是寄進來的,不是要發出去的。反過來,若作者
// 宣告了 list/detail(例如公開留言板那種 UGC),推論不成立,行為與過去完全一致。

/** 收件匣狀態。刻意只有三個 —— 理由見 src/lib/submissions.ts 檔頭。 */
export const SUBMISSION_STATES = ["unread", "read", "archived"] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/** 側表無列(舊資料 / 剛寄進來尚未被動過)一律視為未讀。 */
export const DEFAULT_SUBMISSION_STATE: SubmissionState = "unread";

export function isSubmissionState(value: unknown): value is SubmissionState {
  return (
    typeof value === "string" &&
    (SUBMISSION_STATES as readonly string[]).includes(value)
  );
}

/** 判定所需的最小 content type 形狀(見檔頭:嚴格與鬆散 manifest 共用)。 */
export interface SubmissionTypeShape {
  name?: string;
  public?: boolean;
  kind?: string;
}

/** 判定所需的最小 public route 形狀。 */
export interface SubmissionRouteShape {
  view?: string;
  contentType?: string;
}

/** 判定所需的最小 manifest 形狀。 */
export interface SubmissionManifestShape {
  contentTypes?: readonly SubmissionTypeShape[];
  publicRoutes?: readonly SubmissionRouteShape[];
}

/**
 * 該 type 是否有「公開可讀」的路由(list 或 detail)。form 不算 —— 公開表單只寫不讀。
 */
export function hasPublicReadRoute(
  manifest: SubmissionManifestShape,
  typeName: string,
): boolean {
  return (manifest.publicRoutes ?? []).some(
    (route) =>
      route?.contentType === typeName &&
      (route?.view === "list" || route?.view === "detail"),
  );
}

/** 單一 content type 是否為收件匣型別(規則見檔頭 a/b/c)。 */
export function isSubmissionType(
  manifest: SubmissionManifestShape,
  ct: SubmissionTypeShape,
): boolean {
  if (ct.kind === "submission") return true;
  if (ct.kind === "content") return false;
  if (ct.public !== true) return false;
  return !hasPublicReadRoute(manifest, ct.name ?? "");
}

/** 整份 manifest 中所有收件匣型別的 local name 集合。 */
export function submissionTypeNames(
  manifest: SubmissionManifestShape,
): Set<string> {
  const names = new Set<string>();
  for (const ct of manifest.contentTypes ?? []) {
    if (typeof ct?.name !== "string") continue;
    if (isSubmissionType(manifest, ct)) names.add(ct.name);
  }
  return names;
}

/** 以 local type name 判定(Content API 路徑用:它只有 typeName 字串在手)。 */
export function isSubmissionTypeName(
  manifest: SubmissionManifestShape,
  typeName: string,
): boolean {
  const ct = (manifest.contentTypes ?? []).find((c) => c?.name === typeName);
  return ct ? isSubmissionType(manifest, ct) : false;
}

/**
 * 過濾掉「指向收件匣型別的公開可讀路由」,回傳 interpret 真正應該生成的那些。
 *
 * 這是隱私防線的第二層(第一層是 manifest 驗證時就拒絕整份 manifest)。之所以把它
 * 抽成純函式而不是寫在 interpret.tsx 裡:interpret.tsx 會經 views 拉進
 * next/navigation、next/link、framer-motion,在 workers pool 測試環境載不起來
 * (同 dx/schedule-jobs.ts、dx/dashboard-cards.ts 把邏輯抽出的既有決策)。
 * 「公開面到底會不會生成讀取路由」是本功能最重要的正確性需求,它必須是可以被測試
 * 直接斷言的東西,不能只存在於一個測不到的檔案裡。
 *
 * routes 另外傳入(而不是從 manifest 取)是為了保留呼叫端的具體路由型別 ——
 * interpret 需要拿回 DeclarativePublicRoute 才能繼續建構,不是被抹成最小結構。
 */
export function allowedPublicRoutes<R extends SubmissionRouteShape>(
  manifest: SubmissionManifestShape,
  routes: readonly R[],
  /** 被擋下時的回報(interpret 會 console.error;測試傳空函式)。 */
  onRefused?: (route: R) => void,
): R[] {
  const submissions = submissionTypeNames(manifest);
  return routes.filter((route) => {
    const name = route.contentType;
    if (typeof name !== "string" || !submissions.has(name)) return true;
    // form 例外:公開表單只寫不讀,那正是收件匣的入口。
    if (route.view !== "list" && route.view !== "detail") return true;
    onRefused?.(route);
    return false;
  });
}
