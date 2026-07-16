import { cn } from "@/lib/utils";
import { ACCENT } from "./styles";

// The house status mark from the login: a size-3 ring with a size-1 dot.
// `accent` tints it dither-blue (used on the empty-state glyph); default is ink.

interface RingDotProps {
  accent?: boolean;
  className?: string;
}

export function RingDot({ accent = false, className }: RingDotProps) {
  return (
    <span
      className={cn(
        "relative inline-flex size-3 items-center justify-center rounded-full",
        className,
      )}
      style={{
        boxShadow: `0 0 0 1px ${accent ? ACCENT : "rgba(0,0,0,0.30)"}`,
      }}
      aria-hidden
    >
      <span
        className="size-1 rounded-full"
        style={{ backgroundColor: accent ? ACCENT : "rgba(0,0,0,0.55)" }}
      />
    </span>
  );
}
