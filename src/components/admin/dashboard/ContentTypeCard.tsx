import Link from "next/link";
import { StatNumber } from "@/components/admin/StatNumber";
import { cn } from "@/lib/utils";
import type { DashboardTypeStats } from "./aggregate";
import { SHADOW_RING, SHADOW_RING_HOVER, ACCENT } from "./styles";
import { ProgressRing, ProportionBar } from "./widgets";
import { StatusDot } from "./StatusDot";

// Task #4 §per-type card,2026-07 第二次改版:第一版讓四張卡用「同一個 ring
// 模板」承載差異巨大的資料 —— 31 筆的類型跟 1 筆的類型長得一模一樣,而 ring
// 對其中三張根本無意義(投稿類 0% 發布 = 空環像壞掉;單筆 100% = 噪音)。
// 這版改成「卡片形態跟著資料形狀走」,不是固定模板:
//   · hero —— 內容量最大的類型(佔全站絕大多數),吃滿整列 + 光暈殼 + 橫向
//     比例條(bare ProportionBar,寬版面才用得起橫向空間,ring 用不到)。
//   · ratio —— 已發布/草稿都有且量夠,發布率才承載資訊 → 保留 compact ring。
//   · inbox —— 0 已發布、有草稿(表單投稿無發布流程),不畫發布率,改標「待處理」。
//   · settled —— 無草稿(全數已發布),不畫永遠 100% 的環,改標「全部已發布」。
// 白底 + shadow-ring,concentric radii,唯一 accent = dither-blue。

type CardLabels = {
  published: string;
  draft: string;
  drafts: string;
  new: string;
  viewAll: string;
  allPublished: string;
  awaitingReview: string;
  ofAllContent: string;
};

interface ContentTypeCardProps {
  stats: DashboardTypeStats;
  labels: CardLabels;
  /** rank-0(內容量最大)由 page.tsx 標成 hero;其餘走 standard。 */
  emphasis?: "hero" | "standard";
  /** hero 專用:此類型佔全站內容的比例(真實數字,解釋「為何它是主角」)。 */
  shareOfTotal?: number;
}

type StandardTreatment = "ratio" | "inbox" | "settled";

// 純函式:standard 卡的內部呈現由資料形狀決定(見檔頭)。inbox 先判(0 發布),
// 再 settled(0 草稿),否則 ratio。
export function standardTreatment(s: {
  published: number;
  drafts: number;
}): StandardTreatment {
  if (s.published === 0 && s.drafts > 0) return "inbox";
  if (s.drafts === 0) return "settled";
  return "ratio";
}

/** One count in the split: ring-dot + number + caption. */
function SplitStat({
  tone,
  value,
  label,
}: {
  tone: "good" | "draft";
  value: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <StatusDot tone={tone} />
      <span className="text-[14px] font-semibold tabular-nums text-black/85">
        <StatNumber value={value} />
      </span>
      <span className="text-[12px] text-black/40">{label}</span>
    </div>
  );
}

/** New (ghost) + View all (primary) — always right-aligned per the design doc. */
function CardActions({
  stats,
  labels,
}: {
  stats: DashboardTypeStats;
  labels: CardLabels;
}) {
  return (
    <div className="mt-0.5 flex justify-end gap-2">
      <Link
        href={stats.newHref}
        className={cn(
          "inline-flex h-8 items-center rounded-[8px] bg-white px-3 text-[12.5px] font-semibold text-black/70",
          "transition-[color,box-shadow] duration-150 ease-out active:scale-[0.96]",
          "hover:text-black/90",
          SHADOW_RING,
        )}
      >
        {labels.new}
      </Link>
      <Link
        href={stats.collectionHref}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-black px-3 text-[12.5px] font-semibold text-white",
          "transition-[background-color,transform] duration-150 ease-out",
          "hover:bg-black/85 active:scale-[0.96]",
        )}
      >
        {labels.viewAll}
        <span className="text-white/60">→</span>
      </Link>
    </div>
  );
}

// ── HERO ────────────────────────────────────────────────────────────────────
// 內容量最大的類型。光暈殼(login 的 hero 手法:20px 殼 p-1.5 → 14px 卡),整列
// 寬度,橫向 proportion bar 吃滿水平空間。一頁只有一張 hero(design doc 規定)。
function HeroCard({
  stats,
  labels,
  shareOfTotal,
}: {
  stats: DashboardTypeStats;
  labels: CardLabels;
  shareOfTotal: number;
}) {
  const { typeLabel, extName, total, published, drafts } = stats;
  const sharePct = Math.round(shareOfTotal * 100);

  return (
    <div className="rounded-[20px] bg-white/55 p-1.5 backdrop-blur">
      <div
        className={cn(
          "flex flex-col gap-6 rounded-[14px] bg-white px-[22px] py-5 md:flex-row md:items-center md:gap-8",
          SHADOW_RING,
        )}
      >
        {/* Left: identity + the one large number + why-it's-featured caption. */}
        <div className="flex shrink-0 flex-col gap-1 md:min-w-[190px]">
          <div className="text-[17px] font-semibold tracking-[-0.01em] text-black/90">
            {typeLabel}
          </div>
          <div className="text-[12px] text-black/40">{extName}</div>
          <div className="mt-2 text-[46px] font-semibold leading-[0.9] tabular-nums tracking-[-0.03em] text-black/90">
            <StatNumber value={total} />
          </div>
          {sharePct > 0 && (
            <div className="mt-1 text-[12px] tabular-nums text-black/40">
              {sharePct}% {labels.ofAllContent}
            </div>
          )}
        </div>

        {/* Center: horizontal proportion bar (published vs draft) — the visual a
            ring can't be in a wide slot — over the precise split readings. */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-3.5">
          <ProportionBar
            height={14}
            segments={[
              { id: "published", label: labels.published, value: published },
              { id: "draft", label: labels.draft, value: drafts },
            ]}
            colors={[ACCENT, "rgba(0,0,0,0.14)"]}
          />
          <div className="flex flex-wrap gap-x-6 gap-y-1.5">
            <SplitStat tone="good" value={published} label={labels.published} />
            <SplitStat
              tone="draft"
              value={drafts}
              label={drafts === 1 ? labels.draft : labels.drafts}
            />
          </div>
        </div>

        {/* Right: actions, bottom-aligned on wide layouts. */}
        <div className="flex shrink-0 items-end md:self-stretch">
          <CardActions stats={stats} labels={labels} />
        </div>
      </div>
    </div>
  );
}

// ── STANDARD ─────────────────────────────────────────────────────────────────
// Shared header (label + ext + big total) — identical across variants; only the
// middle "reading" changes to match what the number actually means.
function StandardHeader({
  stats,
}: {
  stats: DashboardTypeStats;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-px">
        <div className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
          {stats.typeLabel}
        </div>
        <div className="text-[12px] text-black/40">{stats.extName}</div>
      </div>
      <div className="text-[30px] font-semibold leading-[0.9] tabular-nums tracking-[-0.02em] text-black/90">
        <StatNumber value={stats.total} />
      </div>
    </div>
  );
}

function StandardBody({
  treatment,
  stats,
  labels,
}: {
  treatment: StandardTreatment;
  stats: DashboardTypeStats;
  labels: CardLabels;
}) {
  const { total, published, drafts } = stats;

  // ratio —— 發布率有意義:ring(published/total)+ 並排文字。
  if (treatment === "ratio") {
    return (
      <div className="flex items-center gap-4">
        <ProgressRing value={published} total={total} size={56} />
        <div className="flex flex-col gap-1.5">
          <SplitStat tone="good" value={published} label={labels.published} />
          <SplitStat
            tone="draft"
            value={drafts}
            label={drafts === 1 ? labels.draft : labels.drafts}
          />
        </div>
      </div>
    );
  }

  // inbox —— 全是草稿的投稿堆:不畫發布率(0% 空環會像壞掉),標「待處理」。
  if (treatment === "inbox") {
    return <SplitStat tone="draft" value={drafts} label={labels.awaitingReview} />;
  }

  // settled —— 全數已發布:不畫永遠滿的環(是噪音),標「全部已發布」。
  return <SplitStat tone="good" value={published} label={labels.allPublished} />;
}

function StandardCard({
  stats,
  labels,
}: {
  stats: DashboardTypeStats;
  labels: CardLabels;
}) {
  const treatment = standardTreatment(stats);

  return (
    <div
      className={cn(
        "group flex flex-col gap-3.5 rounded-[16px] bg-white px-[18px] pt-[18px] pb-3.5",
        "transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5",
        SHADOW_RING,
        SHADOW_RING_HOVER,
      )}
    >
      <StandardHeader stats={stats} />
      {/* flex-1 keeps every standard card's action row at the same baseline even
          though the variant bodies differ in height. */}
      <div className="flex flex-1 items-center">
        <StandardBody treatment={treatment} stats={stats} labels={labels} />
      </div>
      <CardActions stats={stats} labels={labels} />
    </div>
  );
}

export function ContentTypeCard({
  stats,
  labels,
  emphasis = "standard",
  shareOfTotal = 0,
}: ContentTypeCardProps) {
  if (emphasis === "hero") {
    return <HeroCard stats={stats} labels={labels} shareOfTotal={shareOfTotal} />;
  }
  return <StandardCard stats={stats} labels={labels} />;
}
