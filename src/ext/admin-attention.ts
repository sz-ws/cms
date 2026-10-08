import { defineValueSlot, type SlotRegistry } from "./slots";

// 側欄上「這一頁有事在等」的提示(插槽的機制見 slots.ts;1.77.0)。
//
// 後台有些頁會累積等人處理的事:有人回報了匯款等著核對、有申請等著審…。core 不知道有哪些;有這種事的
// 插件各報一項(AdminAttention):哪一頁、現在有幾件。側欄向 GET /api/admin/attention 問(readAdminAttention),
// 有事在等的那一頁旁邊畫一個點 —— 只畫點,不畫數字。
//
// 只問這個人打得開的頁(canOpen 由呼叫端依登入的人決定):打不開的頁連問都不問,那一頁有幾件事不會漏給他。
// 來源一起問,各自最多等 2 秒;回的不是數字,那一頁當作沒有事。丟例外、卡住的那一頁另外列在 unknown:
// 那不是「沒有事」,是「這次不知道」,側欄留著它原本的點(不會因為資料庫忙一下就把點拿掉)。其他來源照常。
//
// 插件這樣報:
//   fill(AdminAttention, (sources) => [...sources, { href: "/admin/ext/my-plugin", count: () => countWaiting() }])
// 一定要 append(`[...sources, X]`),不要整包換掉。count 每問一次就被叫一次(側欄換頁時問,平常大約兩分鐘
// 問一次),所以要便宜:一句 COUNT,不要把整張表讀回來。那一頁處理完一件事之後呼叫 refreshAdminAttention()
// (components/admin/attention.tsx),點馬上跟著更新。

export interface AdminAttentionSource {
  /** 側欄上的那一頁(後台路徑,例如 "/admin/ext/orders")。 */
  href: string;
  /** 現在有幾件事在等人處理;0 就不畫。 */
  count: () => number | Promise<number>;
}

export const AdminAttention = defineValueSlot<AdminAttentionSource[]>("admin.sidebar.attention");

/** 一次最多問幾個來源(擋住填壞的;一個站有事在等的頁不會多)。 */
const MAX_SOURCES = 50;
/** 一個來源最多等多久。側欄在等這個回應;查不完就當作那一頁沒有事。 */
const ANSWER_TIMEOUT_MS = 2_000;
/** 一頁最多算到幾件(側欄只畫點,不必知道更多)。 */
const MAX_COUNT = 9_999;

/** 報上來的一項 → 來源;形狀不對(或連讀都會丟例外)就是 null。count 照原本的物件呼叫。 */
function toSource(value: unknown): AdminAttentionSource | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const { href, count } = value as Record<string, unknown>;
    if (typeof href !== "string" || typeof count !== "function") return null;
    return { href, count: () => (count as AdminAttentionSource["count"]).call(value) };
  } catch {
    return null;
  }
}

/** 後台的頁:/admin 或 /admin/…(帶著 ?篩選 或 #位置 的看路徑那一段)。 */
function isAdminHref(href: string): boolean {
  const path = href.split(/[?#]/, 1)[0];
  return path === "/admin" || path.startsWith("/admin/");
}

/** 問一個來源,最多等 ANSWER_TIMEOUT_MS;逾時就丟例外(呼叫端當作出錯)。 */
async function ask(source: AdminAttentionSource): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ANSWER_TIMEOUT_MS} ms`)), ANSWER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => source.count()), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** 來源回的東西 → 件數:不是 1 以上的有限數字就是 0;小數捨去,最多 MAX_COUNT。 */
function toCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 0;
  return Math.min(Math.floor(value), MAX_COUNT);
}

export interface AdminAttentionAnswer {
  /** href → 件數;沒有事的頁不在裡面。 */
  counts: Record<string, number>;
  /** 這次有來源問不到(丟例外、逾時)的頁:不是「沒有事」,是「這次不知道」—— 側欄留著它原本的樣子。 */
  unknown: string[];
}

/**
 * 每一頁現在有幾件事在等,以及哪幾頁這次問不到。canOpen:這個人打不打得開那一頁 —— 打不開的不問。
 * 同一頁有好幾個來源就加起來。
 */
export async function askAdminAttention(
  slots: SlotRegistry,
  canOpen: (href: string) => boolean,
): Promise<AdminAttentionAnswer> {
  const reported: unknown = slots.value(AdminAttention, []);
  const sources = (Array.isArray(reported) ? reported : [])
    .map(toSource)
    .filter((source): source is AdminAttentionSource => source !== null)
    .filter((source) => isAdminHref(source.href) && canOpen(source.href))
    .slice(0, MAX_SOURCES);

  const answers = await Promise.all(
    sources.map(async (source): Promise<number | null> => {
      try {
        return toCount(await ask(source));
      } catch (error) {
        console.error("[admin-attention] a source could not say how many are waiting", source.href, error);
        return null;
      }
    }),
  );

  const totals = new Map<string, number>();
  const unknown = new Set<string>();
  sources.forEach((source, index) => {
    const answer = answers[index];
    if (answer === null) unknown.add(source.href);
    totals.set(source.href, Math.min((totals.get(source.href) ?? 0) + (answer ?? 0), MAX_COUNT));
  });
  return { counts: Object.fromEntries([...totals].filter(([, total]) => total > 0)), unknown: [...unknown] };
}

/** 只要件數的呼叫端用:問不到的頁當作沒有事。 */
export async function readAdminAttention(
  slots: SlotRegistry,
  canOpen: (href: string) => boolean,
): Promise<Record<string, number>> {
  return (await askAdminAttention(slots, canOpen)).counts;
}
