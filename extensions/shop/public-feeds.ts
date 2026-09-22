import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// 0.4.0(core 1.48.0 的 Extension.publicFeeds):給宣告式插件 script 用的公開資料。
// 例如購買通知浮層用 `{{feed.shop.recentPurchases}}` 取最近的成交。
//
// 這份資料會以 JSON 嵌進**每個公開頁的原始碼**,所以只放商品名、件數、時間。
// 訂單裡的姓名、email、電話、地址、金額一個欄位都不出去 —— 真實成交不掛名字,
// 替它編一個買家也不行 —— 那是在真實紀錄上捏造身分。

/** 已經成交的狀態:付了錢之後的每一步都算,退款、取消不算。 */
const PURCHASED = ["paid", "shipped", "completed"] as const;
const LIMIT = 20;

export interface RecentPurchase {
  /** 第一個品項的名稱。 */
  product: string;
  /** 這張訂單還有幾個其他品項(0 = 只買這一樣)。 */
  more: number;
  /** 下單時間(epoch ms)。 */
  at: number;
}

export function toRecentPurchase(row: { lines: string; created_at: number }): RecentPurchase | null {
  let lines: unknown;
  try {
    lines = JSON.parse(row.lines);
  } catch {
    return null;
  }
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const first = lines[0] as { name?: unknown };
  const product = typeof first?.name === "string" ? first.name.trim() : "";
  if (product === "" || !Number.isFinite(row.created_at)) return null;
  return { product, more: lines.length - 1, at: row.created_at };
}

export async function recentPurchases(): Promise<RecentPurchase[]> {
  const rows = await db().all<{ lines: string; created_at: number }>(sql`
    SELECT lines, created_at
    FROM ext_shop_orders
    WHERE status IN (${sql.join(PURCHASED.map((s) => sql`${s}`), sql`, `)})
    ORDER BY created_at DESC
    LIMIT ${LIMIT}
  `);
  return rows.flatMap((row) => toRecentPurchase(row) ?? []);
}
