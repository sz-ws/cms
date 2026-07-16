"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Vendored from uselayouts "stacked-list" (https://uselayouts.com/r/stacked-list.json).
// The original ships as a full demo widget (avatar directory, hugeicons, search).
// What's adopted here is its motion character only: rows sweep in from the lower
// right on a spring, staggered top-to-bottom. Stripped of the demo chrome and the
// @hugeicons dependency; re-skinned by leaving all row styling to the caller so it
// slots into the Paper & Ink dashboard cards unchanged.

const SWEEP_SPRING = {
  type: "spring",
  stiffness: 400,
  damping: 35,
  mass: 0.5,
} as const;

const ITEM_VARIANTS = {
  hidden: { opacity: 0, x: 8, y: 12, rotate: 0.6 },
  visible: { opacity: 1, x: 0, y: 0, rotate: 0 },
};

interface StackedListProps {
  children: ReactNode;
  className?: string;
  /** Seconds between each row's entrance. */
  stagger?: number;
}

export function StackedList({
  children,
  className,
  stagger = 0.04,
}: StackedListProps) {
  return (
    <motion.ul
      initial="hidden"
      animate="visible"
      // The container variant must define BOTH labels — even an empty `hidden` —
      // or motion sees no hidden→visible transition and never orchestrates the
      // staggered children (they'd stay stuck at their own hidden variant).
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: stagger } },
      }}
      className={cn("flex flex-col", className)}
    >
      {children}
    </motion.ul>
  );
}

interface StackedListItemProps {
  children: ReactNode;
  className?: string;
}

export function StackedListItem({ children, className }: StackedListItemProps) {
  return (
    <motion.li
      variants={ITEM_VARIANTS}
      transition={SWEEP_SPRING}
      style={{ originX: 1, originY: 1 }}
      className={className}
    >
      {children}
    </motion.li>
  );
}
