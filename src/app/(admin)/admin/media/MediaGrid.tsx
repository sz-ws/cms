"use client";

import { FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isImage,
  fileNameOf,
  formatBytes,
  typeLabelOf,
  type StoredFileDTO,
} from "./media-utils";

// Task #7 §2: asset grid. One card per file — image outline + aspect box for
// images (per docs/admin-design-language.md: "image outline rgba(0,0,0,0.1)"),
// a file chip for everything else, filename/size/type caption underneath.
// Selection ring uses the dither-blue accent; toggling is a plain click on the
// card (no separate checkbox chrome — keeps the grid quiet).
//
// Layout note: this uses flex-wrap with a FIXED card width. The earlier overlap
// bug came from the card content not respecting the item width; the card/button
// and text rows now opt into `min-w-0` / `truncate`, so long filenames hug the
// card instead of pushing into their neighbours.

interface MediaGridProps {
  files: StoredFileDTO[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
}

function GridItem({
  file,
  selected,
  onToggle,
}: {
  file: StoredFileDTO;
  selected: boolean;
  onToggle: () => void;
}) {
  const img = isImage(file);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      title={file.key}
      className={cn(
        "group flex w-full min-w-0 flex-col overflow-hidden rounded-[14px] bg-white text-left outline-none",
        "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]",
        "transition-[box-shadow,transform] duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100",
        selected
          ? "shadow-[0_0_0_2px_rgb(86,114,228),0_2px_4px_0_rgba(0,0,0,0.04)]"
          : "hover:shadow-[0_0_0_1px_rgba(0,0,0,0.1),0_2px_6px_-2px_rgba(0,0,0,0.12)]",
        "focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)]",
      )}
    >
      <span className="relative block aspect-square w-full shrink-0 overflow-hidden rounded-t-[14px] bg-black/[0.02] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element -- dynamic storage-key source, see MediaPickerDialog.
          <img
            src={`/api/files/${file.key}`}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-1.5 px-2">
            <FileIcon className="size-6 text-black/30" />
            <span className="font-mono text-[10px] lowercase text-black/40">
              {typeLabelOf(file)}
            </span>
          </span>
        )}
        {selected && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-[rgb(86,114,228)] text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)]"
          >
            <svg viewBox="0 0 16 16" className="size-3" fill="none">
              <path
                d="M3.5 8.5L6.5 11.5L12.5 4.5"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
        <span className="block w-full min-w-0 truncate text-[12px] font-medium text-black/80">
          {fileNameOf(file.key)}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] tabular-nums text-black/35">
          <span className="shrink-0">{formatBytes(file.size)}</span>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="truncate lowercase">{typeLabelOf(file)}</span>
        </span>
      </span>
    </button>
  );
}

export function MediaGrid({ files, selected, onToggle }: MediaGridProps) {
  return (
    <ul className="flex flex-wrap gap-4">
      {files.map((file) => (
        <li key={file.key} className="w-[11rem] max-w-full shrink-0">
          <GridItem
            file={file}
            selected={selected.has(file.key)}
            onToggle={() => onToggle(file.key)}
          />
        </li>
      ))}
    </ul>
  );
}
