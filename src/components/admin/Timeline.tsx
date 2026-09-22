"use client";

import { useDateFormatter } from "@/components/DateTimeProvider";

// 1.40.0:後台的紀錄時間軸(一筆訂單、出貨單、佣金經過了哪些動作)。
//
// 插件各自有事件表(ext_shop_events、ext_fulfillment_events…),形狀不同;這裡只管
// 畫,插件把自己的事件轉成 TimelineItem 傳進來。舊的在上、新的在下 —— 讀起來是
// 「這筆訂單怎麼走到現在」。純展示,server / client 元件都能用(1.41.0 起時間用
// 站台時區,所以是 client 元件;items 只有字串與數字,server 直接傳得進來)。

export interface TimelineItem {
  id: string;
  /** epoch ms。 */
  at: number;
  /** 發生了什麼,如「確認收款」。 */
  title: string;
  /** 原因、備註。 */
  detail?: string;
  /** 誰做的;系統動作寫「系統自動」之類。 */
  actor?: string;
}

const WHEN: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

export function Timeline({ items, empty = "還沒有紀錄。" }: { items: TimelineItem[]; empty?: string }) {
  const dates = useDateFormatter("zh-Hant");
  const when = (ts: number) => dates.format(ts, WHEN);
  if (items.length === 0) return <p className="text-[12.5px] text-black/35 admin:text-ink/35">{empty}</p>;
  return (
    <ol className="flex flex-col">
      {items.map((item, i) => (
        <li key={item.id} className="relative flex gap-3 pb-3 last:pb-0">
          {/* 節點與連線:最後一筆不畫往下的線。 */}
          <span aria-hidden className="relative flex w-2 shrink-0 justify-center">
            <span className="mt-[7px] size-[7px] rounded-full bg-black/25 admin:bg-ink/25" />
            {i < items.length - 1 ? (
              <span className="absolute top-[18px] bottom-[-6px] w-px bg-black/[0.08] admin:bg-ink/[0.08]" />
            ) : null}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-black/85 admin:text-ink/85">
              <span className="font-medium">{item.title}</span>
              <time dateTime={new Date(item.at).toISOString()} className="text-[12px] tabular-nums text-black/40 admin:text-ink/40">
                {when(item.at)}
              </time>
            </p>
            {item.detail || item.actor ? (
              <p className="text-[12.5px] text-black/55 admin:text-ink/55">
                {[item.detail, item.actor].filter(Boolean).join(" · ")}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
