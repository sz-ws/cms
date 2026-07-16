import Link from "next/link";

// 設計過的空狀態:ring-dot 記號 + 一句話 + 一顆主要 CTA。無空表格、無 kit spinner。
// 兩種語境:完全沒有資料(showCreate)vs filter 無命中(引導清除)。

interface EmptyStateProps {
  typeLabel: string;
  createHref: string;
  filtered: boolean;
  clearHref: string;
}

export function EmptyState({
  typeLabel,
  createHref,
  filtered,
  clearHref,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-[14px] bg-white px-6 py-16 text-center shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)]">
      <span
        className="inline-flex size-8 items-center justify-center rounded-full ring-1 ring-black/15"
        aria-hidden
      >
        <span className="size-2 rounded-full bg-black/20" />
      </span>
      {filtered ? (
        <>
          <p className="max-w-sm text-[14px] text-black/55">
            No {typeLabel.toLowerCase()} match these filters.
          </p>
          <Link
            href={clearHref}
            className="inline-flex h-10 items-center rounded-[8px] bg-white px-4 text-[14px] font-medium text-black/80 shadow-[0_0_0_1px_rgba(0,0,0,0.1)] transition-[box-shadow,transform] active:scale-[0.96] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.22)]"
          >
            Clear filters
          </Link>
        </>
      ) : (
        <>
          <p className="max-w-sm text-[14px] text-black/55">
            No {typeLabel.toLowerCase()} yet. Create the first one to get
            started.
          </p>
          <Link
            href={createHref}
            className="inline-flex h-10 items-center gap-2 rounded-[8px] bg-black px-4 text-[14px] font-medium text-white transition-[background,transform] active:scale-[0.96] hover:bg-black/85"
          >
            Create {typeLabel.toLowerCase()}
            <span className="text-white/70">→</span>
          </Link>
        </>
      )}
    </div>
  );
}
