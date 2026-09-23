"use client";

import NumberFlow from "@number-flow/react";

// Client wrapper so server pages can animate dynamically-changing numeric stats
// per the project motion policy (NumberFlow + tabular-nums). NumberFlow honours
// prefers-reduced-motion itself.

interface StatNumberProps {
  value: number;
  className?: string;
  /** Locale for grouping and decimals; omitted = the runtime's default. */
  locales?: Intl.LocalesArgument;
}

export function StatNumber({ value, className, locales }: StatNumberProps) {
  return (
    <NumberFlow value={value} locales={locales} className={className} style={{ fontVariantNumeric: "tabular-nums" }} />
  );
}
