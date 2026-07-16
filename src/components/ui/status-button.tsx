"use client";

import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Vendored from uselayouts "status-button" (https://uselayouts.com/r/status-button.json).
// The kept "vibe": the per-character label morph (scale + blur, spring) and the
// soft state-transition on the leading status icon. Re-skinned to Paper & Ink —
// black solid / accent-tinted success — dropping the original's floating badge
// and muted-token palette. No new deps: the original @hugeicons Tick was swapped
// for lucide's Check (already installed).

export type StatusButtonStatus = "idle" | "loading" | "success" | "error";

interface StatusButtonProps {
  status: StatusButtonStatus;
  /** Current label text — caller owns the wording per state (it morphs on change). */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  /** solid = black primary; soft = subtle ink (e.g. the "Update" affordance). */
  variant?: "solid" | "soft";
  /** Leading glyph shown only in the idle state (e.g. a Download icon). */
  idleIcon?: ReactNode;
  className?: string;
  /** Optional inline style passthrough — used by declarative public forms to tint
   * the button with the extension's --ext-accent token (see FormView public mode). */
  style?: CSSProperties;
}

const SIZE = {
  sm: { btn: "h-8 gap-1.5 px-3.5 text-[12px]", icon: "size-3" },
  md: { btn: "h-9 gap-1.5 px-4 text-[13px]", icon: "size-3.5" },
  lg: { btn: "h-10 gap-1.5 px-5 text-[14px]", icon: "size-4" },
} as const;

export function StatusButton({
  status,
  label,
  onClick,
  disabled = false,
  size = "md",
  variant = "solid",
  idleIcon,
  className,
  style,
}: StatusButtonProps) {
  const sz = SIZE[size];
  const isBusy = status === "loading";
  const isDone = status === "success";
  const isDisabled = disabled || isBusy || isDone;
  const hasIcon = status !== "idle" || idleIcon != null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-busy={isBusy}
      style={style}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-medium",
        "transition-[background-color,transform] duration-150 active:scale-[0.96]",
        "disabled:cursor-default",
        sz.btn,
        isDone
          ? "bg-[rgb(86,114,228)]/10 text-[rgb(86,114,228)]"
          : variant === "soft"
            ? "bg-black/[0.06] text-black/70 hover:bg-black/[0.1]"
            : "bg-black text-white hover:bg-black/85",
        isBusy && "cursor-wait opacity-60",
        disabled && !isBusy && !isDone && "opacity-50",
        className,
      )}
    >
      {hasIcon && (
        // Leading status glyph — swaps with a soft scale/blur (the state-transition vibe).
        <span className={cn("relative flex shrink-0 items-center justify-center", sz.icon)}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={status}
              initial={{ opacity: 0, scale: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0, filter: "blur(4px)" }}
              transition={{ type: "spring", stiffness: 400, damping: 28 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              {status === "loading" ? (
                <Loader2 className={cn(sz.icon, "animate-spin")} />
              ) : status === "success" ? (
                <Check className={sz.icon} />
              ) : status === "error" ? (
                <AlertCircle className={sz.icon} />
              ) : (
                idleIcon ?? null
              )}
            </motion.span>
          </AnimatePresence>
        </span>
      )}

      {/* Per-character label morph — the status-button signature motion. */}
      <span className="flex items-center">
        <AnimatePresence mode="popLayout" initial={false}>
          {label.split("").map((char, i) => (
            <motion.span
              key={`${char}-${i}`}
              layout
              initial={{ opacity: 0, scale: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0, filter: "blur(4px)" }}
              transition={{ type: "spring", stiffness: 500, damping: 30, mass: 1 }}
              className="inline-block whitespace-pre"
            >
              {char}
            </motion.span>
          ))}
        </AnimatePresence>
      </span>
    </button>
  );
}
