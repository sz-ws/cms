"use client";

import NumberFlow from "@number-flow/react";

// Client wrapper so server pages can animate dynamically-changing numeric stats
// per the project motion policy (NumberFlow + tabular-nums). NumberFlow honours
// prefers-reduced-motion itself.

interface StatNumberProps {
  value: number;
  className?: string;
}

export function StatNumber({ value, className }: StatNumberProps) {
  return (
    <NumberFlow value={value} className={className} style={{ fontVariantNumeric: "tabular-nums" }} />
  );
}
