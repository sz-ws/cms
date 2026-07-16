"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";

// Small create menu shown in the page header when 2+ content types exist, so a
// new entry of any type is one click from the dashboard. Single type → the
// per-card "New" button already covers this, so the page omits it.
//
// Floating layer uses the design-language ambient shadow. Closes on outside
// click + Escape. This is the only interactive client bit on the dashboard.

export interface QuickCreateOption {
  label: string;
  extName: string;
  href: string;
}

interface QuickCreateProps {
  options: QuickCreateOption[];
}

export function QuickCreate({ options }: QuickCreateProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-black px-3.5 text-[13px] font-medium text-white",
          "transition-[background-color,transform] duration-150 ease-out",
          "hover:bg-black/85 active:scale-[0.96]",
        )}
      >
        {t("quickCreate.newEntry")}
        <span
          className={cn(
            "text-white/70 transition-transform duration-150 ease-out",
            open && "rotate-180",
          )}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute right-0 z-20 mt-1.5 w-56 overflow-hidden rounded-[12px] bg-white p-1.5",
            "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_16px_48px_-12px_rgba(30,20,50,0.18)]",
          )}
        >
          {options.map((o) => (
            <Link
              key={o.href}
              href={o.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center justify-between gap-3 rounded-[8px] px-3 py-2",
                "transition-colors duration-150 ease-out hover:bg-black/[0.03]",
              )}
            >
              <span className="text-[13px] font-medium text-black/85">
                {o.label}
              </span>
              <span className="text-[11px] text-black/35">{o.extName}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
