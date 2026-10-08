import { isSitePath } from "./site-path";
import { defineValueSlot, type SlotRegistry } from "./slots";

// 登入之後、送去目的地之前,多走一步(插槽的機制見 slots.ts)。
//
// 有些事要趁人剛登入的時候請他做完:補一個聯絡得到他的方式、同意新的條款…。core 不知道有哪些;有這種事的
// 插件各加一項(AfterSignIn),/api/auth/continue 決定好目的地之後照先後問一輪(afterSignInDetour),
// 第一個說「要」的那一步先去。原本的目的地放在那一步網址的 ?next= 上:那一步做完,或這個人說以後再做,
// 由那一頁接著送過去(送之前自己再驗一次是站內路徑 —— ?next= 是網址上的東西,誰都能改)。
//
// 只問一般會員。後台人員(管理員、編輯、自訂角色)永遠不繞路:他們的登入不能卡在某個插件的頁面上。
// 沒有人加、加的那一項壞了(丟例外、回的不是站內路徑、2 秒內沒有回答)、整個讀不到:照原本的目的地走,
// 登入不受影響。
//
// 插件這樣加:
//   fill(AfterSignIn, (steps) => [...steps, { key: "email", path: async (person) => (needsEmail(person) ? "/member/email" : null) }])
// 一定要 append(`[...steps, X]`),不要整包換掉。

/** 剛登入的那個人(一定是一般會員)。 */
export interface SignedInPerson {
  id: string;
  email: string;
}

export interface AfterSignInStep {
  /** 穩定的代號(小寫英數與 -)。同一個代號後填的蓋掉先填的,位置照第一次出現的。 */
  key: string;
  /**
   * 這個人現在要不要先走這一步:要就回那一步的站內路徑(/ 開頭),不用回 null。可以查資料(回 Promise)。
   * 丟例外、回的不是站內路徑、或 2 秒內沒有回答,這一項會被跳過。
   */
  path(person: SignedInPerson): string | null | Promise<string | null>;
}

export const AfterSignIn = defineValueSlot<AfterSignInStep[]>("auth.after-sign-in");

const KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** 一項最多等多久。登入的人正在等轉址;查不完就當作這一步不用走。 */
const ANSWER_TIMEOUT_MS = 2_000;
/** 只拿來解析站內路徑的假網域;不會出現在結果裡。 */
const BASE = "https://site.invalid";

function isStep(value: unknown): value is AfterSignInStep {
  if (typeof value !== "object" || value === null) return false;
  const { key, path } = value as Record<string, unknown>;
  return typeof key === "string" && KEY_RE.test(key) && typeof path === "function";
}

/** 填的人給的清單收斂:寫壞的丟掉並記一筆;同一個代號留最後填的那一份。 */
function normalize(value: unknown): AfterSignInStep[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, AfterSignInStep>();
  for (const item of value) {
    if (isStep(item)) byKey.set(item.key, item);
    else console.error("[after-sign-in] dropped a step that is not { key, path() }", item);
  }
  return [...byKey.values()];
}

const pathnameOf = (path: string): string => new URL(path, BASE).pathname;

/** 問一項,最多等 ANSWER_TIMEOUT_MS;逾時就丟例外(呼叫端當作出錯跳過)。 */
async function ask(step: AfterSignInStep, person: SignedInPerson): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ANSWER_TIMEOUT_MS} ms`)), ANSWER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => step.path(person)), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** 那一步的網址加上 ?next=<原本的目的地>。 */
function withNext(step: string, destination: string): string {
  const url = new URL(step, BASE);
  url.searchParams.set("next", destination);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * 這個人登入後要先去的那一步(帶著 ?next=<destination>);沒有就是 null,照 destination 走。
 * destination 是呼叫端已經驗過的站內路徑。role 不是 guest(後台人員)一律 null,不問任何插件。
 */
export async function afterSignInDetour(
  slots: SlotRegistry,
  person: SignedInPerson & { role: string },
  destination: string,
): Promise<string | null> {
  if (person.role !== "guest") return null;
  const asked: SignedInPerson = { id: person.id, email: person.email };
  for (const step of normalize(slots.value(AfterSignIn, []))) {
    try {
      const path = await ask(step, asked);
      if (path === null || path === undefined) continue;
      if (!isSitePath(path)) {
        console.error(`[after-sign-in] "${step.key}" gave a path that is not on this site; skipped`);
        continue;
      }
      // 本來就要去那一頁:不用再繞一次。
      if (pathnameOf(path) === pathnameOf(destination)) return null;
      const detour = withNext(path, destination);
      if (isSitePath(detour)) return detour;
      console.error(`[after-sign-in] "${step.key}" gave a path that is not on this site; skipped`);
    } catch (error) {
      console.error(`[after-sign-in] "${step.key}" could not tell whether it applies`, error);
    }
  }
  return null;
}
