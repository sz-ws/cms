"use client";

import { useEffect, useRef, useState } from "react";
import { LockIcon, LockOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { SlugFieldProps } from "./types";

// slug field: auto-kebab-cases from the slugField source value (wired by
// FormView via the `sourceValue` prop) until the user edits the slug input
// manually — then it locks and stops following the source. Lock/unlock is
// also a manual toggle. Stored value: kebab-case string
// (content-provider.ts also re-slugifies + uniquifies server-side; this is
// just the friendly live preview).

function kebabCase(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function SlugField({
  value,
  onChange,
  field,
  error,
  disabled,
  sourceValue,
}: SlugFieldProps) {
  // Locked = auto-sync from sourceValue. Unlocks the moment the user types
  // directly into the slug input, or can be manually re-locked/unlocked.
  const [locked, setLocked] = useState(true);
  const lastAutoValue = useRef<string>("");

  useEffect(() => {
    if (!locked || sourceValue === undefined) return;
    const next = kebabCase(sourceValue);
    if (next === lastAutoValue.current && next === value) return;
    lastAutoValue.current = next;
    onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, sourceValue]);

  return (
    <div className="flex items-stretch gap-1.5">
      <Input
        id={`field-${field.key}`}
        value={value ?? ""}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        className="flex-1"
        onChange={(e) => {
          const typed = kebabCase(e.target.value);
          if (locked) setLocked(false);
          onChange(typed);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        disabled={disabled}
        aria-pressed={locked}
        aria-label={locked ? "Unlock slug (stop auto-sync)" : "Lock slug (auto-sync from title)"}
        title={locked ? "Auto-syncing from title" : "Manually edited"}
        className={cn(
          "h-9 w-9 shrink-0 rounded-3xl transition-[background-color,color] active:scale-[0.96]",
          locked && "text-primary",
        )}
        onClick={() => setLocked((prev) => !prev)}
      >
        {locked ? <LockIcon className="size-4" /> : <LockOpenIcon className="size-4" />}
      </Button>
    </div>
  );
}
