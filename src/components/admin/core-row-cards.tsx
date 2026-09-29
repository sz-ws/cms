import { Fragment, type ReactNode } from "react";

// 1.64.0:窄螢幕(640px 以下)的清單 —— 一列一張卡片,重要的欄位在上面。CoreTable 給了 cards 就兩份都畫,
// CSS 決定顯示哪一份(display:none 的那份不在無障礙樹裡,也按不到);也可以單獨用在不是表格的清單。
// i18n 在消費端解好,這層不碰字典。

/** 卡片上的一個欄位。render 回 null、undefined、false 或 "" 的那一格不畫。CoreColumn 也能直接放。 */
export interface CoreCardField<T> {
  key: string;
  label: ReactNode;
  render: (row: T) => ReactNode;
}

/** 卡片的主要動作:按鈕的點擊範圍撐滿整張卡。about:螢幕閱讀器聽到的「哪一筆」(按鈕字後面)。 */
export interface CoreCardAction {
  text: string;
  onClick: () => void;
  about?: string;
  /** 醒目的實心按鈕(要客人做的事);沒給是安靜的外框按鈕。 */
  primary?: boolean;
}

export interface CoreRowCardsProps<T> {
  /** 清單的無障礙名稱。 */
  label?: string;
  /** 卡片最上面那一行(編號、名稱)。 */
  title: (row: T) => ReactNode;
  /** 右上角,通常是狀態。 */
  badge?: (row: T) => ReactNode;
  fields: CoreCardField<T>[];
  action?: (row: T) => CoreCardAction | null;
  /** 動作鈕旁邊的其他連結或按鈕(疊在撐滿卡片的點擊範圍上面,按得到)。 */
  extra?: (row: T) => ReactNode;
}

const CARD = "relative rounded-[12px] admin:rounded-[calc(12px*var(--admin-radius-scale,1))] bg-white admin:bg-surface px-4 py-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]";
// 動作鈕不能有 relative、transform 或 scale(按下去縮一下):撐滿卡片的 ::after 會改以按鈕為準,
// 點在卡片的其他地方就按不到了。
const ACTION = "inline-flex min-h-10 items-center justify-center rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] px-4 text-[13px] font-medium transition-colors after:absolute after:inset-0";
const PRIMARY = "bg-black admin:bg-ink text-white hover:bg-black/85 admin:hover:bg-ink/85";
const QUIET = "bg-white admin:bg-surface text-black/70 admin:text-ink/70 shadow-[0_0_0_1px_rgba(0,0,0,0.08)] hover:bg-black/[0.02] admin:hover:bg-ink/[0.02]";

const shown = (value: ReactNode) => value !== null && value !== undefined && value !== false && value !== "";

/** 一列一張卡片的清單,只在 640px 以下顯示(寬螢幕是表格)。 */
export function CoreRowCards<T>({ rows, rowKey, label, title, badge, fields, action, extra }: CoreRowCardsProps<T> & {
  rows: T[];
  rowKey: (row: T) => string;
}) {
  return (
    <ul aria-label={label} data-row-cards="" className="flex flex-col gap-2.5 sm:hidden">
      {rows.map((row) => {
        const act = action?.(row) ?? null;
        const more = extra?.(row);
        const values = fields.map((field) => ({ field, value: field.render(row) })).filter(({ value }) => shown(value));
        return (
          <li key={rowKey(row)} className={CARD}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 [overflow-wrap:anywhere]">{title(row)}</div>
              {badge && <div className="shrink-0">{badge(row)}</div>}
            </div>
            {values.length > 0 && (
              <dl className="mt-2.5 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-snug">
                {values.map(({ field, value }) => (
                  <Fragment key={field.key}>
                    <dt className="text-black/45 admin:text-ink/45">{field.label}</dt>
                    <dd className="min-w-0 text-black/85 admin:text-ink/85 [overflow-wrap:anywhere]">{value}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
            {(act || shown(more)) && (
              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                {shown(more) && <div className="relative z-10">{more}</div>}
                {act && (
                  <button type="button" onClick={act.onClick} className={`${ACTION} ${act.primary ? PRIMARY : QUIET}`}>
                    {act.text}
                    {act.about && <span className="sr-only"> {act.about}</span>}
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
