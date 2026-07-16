"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { ChevronRightIcon, CodeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FieldComponentProps } from "./types";

// json field: CodeMirror 6 (json lang), dynamically imported with ssr:false
// so the editor chunk never ships to public pages or non-json admin forms.
// Collapsed by default per dx-field-components.md ("Collapsed by default,
// expandable"). Stored value: arbitrary JSON. Edited as text; parsed on blur;
// parse failure shows an inline error and keeps the raw text (does not clear
// user input).

const JsonCodeEditor = dynamic(() => import("./JsonCodeEditor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-32 items-center justify-center rounded-2xl border border-input/60 bg-input/30 text-sm text-muted-foreground">
      Loading editor…
    </div>
  ),
});

function stringify(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

export function JsonField({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<unknown>) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState(() => stringify(value));
  const [parseError, setParseError] = useState<string | null>(null);

  function handleBlur() {
    const trimmed = text.trim();
    if (trimmed === "") {
      setParseError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      setParseError(null);
      onChange(parsed);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON");
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        id={`field-${field.key}`}
        onClick={() => setExpanded((prev) => !prev)}
        disabled={disabled}
        aria-expanded={expanded}
        className={cn(
          "flex h-9 min-h-9 w-full items-center gap-2 rounded-3xl border border-transparent bg-input/50 px-3 text-left text-sm font-medium transition-[background-color,color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.96]",
          error && "border-destructive",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
        <CodeIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-muted-foreground">
          {expanded ? "Hide JSON editor" : "Show JSON editor"}
        </span>
      </button>

      {expanded && (
        <>
          <JsonCodeEditor
            value={text}
            onChange={setText}
            onBlur={handleBlur}
            disabled={disabled}
          />
          {(parseError || error) && (
            <p className="text-sm text-destructive">{parseError ?? error}</p>
          )}
        </>
      )}
    </div>
  );
}
