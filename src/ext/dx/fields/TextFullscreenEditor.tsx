"use client";

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Expand, Shrink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import type { FieldComponentProps } from "./types";
import { fieldLabel } from "../views/field-utils";
import { useExtLocale } from "../ext-locale";

/**
 * 多行 text 編輯:
 *  - 平時是一個內嵌的 Paper & Ink textarea
 *  - 「Expand」把編輯器放大成 fixed overlay,讓長文寫作時不擠在主表單裡
 *  - Esc 收合,cmd/ctrl-enter 也收合
 *
 * 設計上同一個 textarea 在普通與全螢幕間共用(透過動態 ref 切換容器樣式),
 * 不複製 state,避免寫到一半 bounce。
 */
export function TextFullscreenEditor({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<string>) {
  const [open, setOpen] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const label = fieldLabel(field, useExtLocale());

  const close = useCallback(() => setOpen(false), []);

  // 全螢幕開啟時自動 focus;收合時還焦點。
  useEffect(() => {
    if (open) {
      // next tick — overlay 元素 mount 後才能 focus
      const t = requestAnimationFrame(() => textRef.current?.focus());
      return () => cancelAnimationFrame(t);
    }
    return undefined;
  }, [open]);

  // Esc + Cmd/Ctrl-Enter 收合
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      close();
    }
  }

  const sharedProps = {
    id: `field-${field.key}`,
    value: value ?? "",
    disabled,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value),
    onKeyDown,
    "aria-invalid": Boolean(error),
    placeholder: label,
  } as const;

  const compactClass = cn(
    "min-h-[88px] max-h-[260px] resize-y rounded-[10px] border-black/10 bg-white px-3 py-2 text-[14px] text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-black/25 focus:border-black/30 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.05)] aria-invalid:border-red-600/40 aria-invalid:shadow-[0_0_0_3px_rgba(185,28,28,0.12)]",
  );

  const fullscreenClass = cn(
    "block w-full flex-1 resize-none rounded-[14px] border border-black/10 bg-white px-5 py-4 text-[16px] leading-relaxed text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-black/25 focus:border-black/30 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.05)] aria-invalid:border-red-600/40",
  );

  return (
    <>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${label} — expanded editor`}
          className="fixed inset-0 z-50 flex flex-col bg-[#fbfaf9]/95 backdrop-blur-md p-4 sm:p-8"
        >
          <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-black/55">
                {label}
              </span>
              <button
                type="button"
                aria-label="Collapse editor"
                onClick={close}
                className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-black/10 bg-white px-3 text-[13px] font-medium text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] transition-colors hover:bg-black/[0.03] active:scale-[0.96]"
              >
                <Shrink className="size-3.5" />
                Collapse
                <span className="ml-1 hidden text-black/35 sm:inline">esc</span>
              </button>
            </div>
            <Textarea
              {...sharedProps}
              ref={(el) => {
                textRef.current = el;
              }}
              className={fullscreenClass}
            />
            <p className="text-center text-[11.5px] text-black/35">
              Press <kbd className="rounded bg-black/[0.06] px-1.5 py-0.5 font-mono">esc</kbd>{" "}
              or <kbd className="rounded bg-black/[0.06] px-1.5 py-0.5 font-mono">⌘ enter</kbd>{" "}
              to collapse.
            </p>
          </div>
        </div>
      ) : (
        <div className="relative">
          <Textarea
            {...sharedProps}
            ref={(el) => {
              if (!open) textRef.current = el;
            }}
            className={compactClass}
          />
          <button
            type="button"
            aria-label="Expand editor"
            onClick={() => setOpen(true)}
            disabled={disabled}
            className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-[6px] text-black/45 transition-colors hover:bg-black/[0.04] hover:text-black/85 active:scale-[0.94] disabled:opacity-50"
          >
            <Expand className="size-3.5" />
          </button>
        </div>
      )}
    </>
  );
}
