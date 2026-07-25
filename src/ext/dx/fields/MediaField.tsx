"use client";

import { useMemo, useState } from "react";
import { FileIcon, ImageIcon, XIcon, Maximize2, Minimize2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MediaPickerDialog } from "./MediaPickerDialog";
import { buildSrcSet, variantUrl } from "@/lib/image-variants";
import type { FieldComponentProps } from "./types";

// C.5b §2 + visual upgrade: media field. Stored value = R2 storage key string
// (unchanged shape, no data migration). The field now exposes three view modes:
//   - cover   = the key is rendered as a 16:9 hero preview (full image)
//   - library = the key is shown with its existing thumbnail + filename chip
//   - manual  = the raw storage key entry (collapsed chip)
//
// Paper & Ink language: white surfaces, shadow-ring (no gray borders),
// concentric radii, 40px hits. Cover preview uses object-contain so non-square
// uploads (horizontal hero shots, vertical portraits) read clearly.

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)$/i;

type ViewMode = "cover" | "library" | "manual";

export function MediaField({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<string>) {
  const key = (value ?? "").trim();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mode, setMode] = useState<ViewMode>("cover");
  const [expanded, setExpanded] = useState(false);

  const looksLikeImage = useMemo(() => IMAGE_EXT_RE.test(key), [key]);
  // 這裡刻意留著原生 <img>(而非共用的 MediaImage):兩個預覽都掛了 onError 來
  // 藏掉壞掉的 key,MediaImage 是無事件的純呈現元件。只把 src/srcSet 換成變體。
  const src = looksLikeImage ? variantUrl(key, { width: 960 }) : null;
  const coverSrcSet = useMemo(
    () => (looksLikeImage ? buildSrcSet(key, 960) : undefined),
    [looksLikeImage, key],
  );
  const thumbSrcSet = useMemo(
    () => (looksLikeImage ? buildSrcSet(key, 320) : undefined),
    [looksLikeImage, key],
  );

  return (
    <div className="flex flex-col gap-3" id={`field-${field.key}`}>
      <Tabs
        value={mode}
        onValueChange={(v) => setMode((v as ViewMode) ?? "cover")}
        className="w-full"
      >
        <div className="flex items-center justify-between gap-3">
          <TabsList className="rounded-[10px] bg-black/[0.04] p-0.5">
            <TabsTrigger value="cover" className="rounded-[8px] px-3 py-1.5 text-[12.5px]">
              Cover
            </TabsTrigger>
            <TabsTrigger
              value="library"
              className="rounded-[8px] px-3 py-1.5 text-[12.5px]"
            >
              Library
            </TabsTrigger>
            <TabsTrigger
              value="manual"
              className="rounded-[8px] px-3 py-1.5 text-[12.5px]"
            >
              Manual
            </TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            {key && src ? (
              <button
                type="button"
                disabled={disabled}
                aria-label={expanded ? "Shrink cover preview" : "Expand cover preview"}
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex h-9 items-center gap-1 rounded-[8px] px-2.5 text-[12.5px] font-medium text-black/55 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] transition-[color,background-color] hover:bg-black/[0.03] hover:text-black/85 active:scale-[0.96] disabled:opacity-50"
              >
                {expanded ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
                {expanded ? "Shrink" : "Expand"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={disabled}
              onClick={() => setPickerOpen(true)}
              data-invalid={error ? "true" : undefined}
              className="inline-flex h-10 items-center rounded-[8px] bg-black px-4 text-[13px] font-medium text-white shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] transition-[background-color] outline-none hover:bg-black/85 focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.25)] active:scale-[0.96] disabled:opacity-50 motion-reduce:active:scale-100 data-[invalid]:shadow-[0_0_0_1px_rgba(185,28,28,0.5)]"
            >
              {key ? "Replace" : "Choose"}
            </button>
            {key && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange("")}
                className="inline-flex h-10 items-center gap-1 rounded-[8px] px-2.5 text-[13px] font-medium text-black/45 transition-[color,background-color] outline-none hover:bg-black/[0.03] hover:text-black/85 active:scale-[0.96] disabled:opacity-50 motion-reduce:active:scale-100"
              >
                <XIcon className="size-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Cover preview — 16:9 hero with object-contain, no clipping of the artwork. */}
        {mode === "cover" ? (
          <div
            className={`relative mt-3 overflow-hidden rounded-[14px] bg-black/[0.02] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] ${
              expanded ? "aspect-[16/9]" : "aspect-[16/9] max-h-[18rem]"
            }`}
          >
            {key ? (
              src ? (
                // eslint-disable-next-line @next/next/no-img-element -- dynamic storage-key source; native img is intentional (see MediaPickerDialog).
                <img
                  src={src}
                  {...(coverSrcSet
                    ? { srcSet: coverSrcSet, sizes: "(max-width: 768px) 100vw, 640px" }
                    : {})}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 size-full object-contain"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.visibility =
                      "hidden";
                  }}
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-black/45">
                  <FileIcon className="size-7" />
                  <span className="font-mono text-[11px] lowercase">
                    {key.split("/").pop()}
                  </span>
                </div>
              )
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-black/35">
                <ImageIcon className="size-7" />
                <span className="text-[12.5px]">No cover image yet</span>
              </div>
            )}
          </div>
        ) : null}

        {/* Library tile — small thumbnail + filename chip + key meta. */}
        {mode === "library" ? (
          <div className="mt-3 flex items-start gap-3">
            <div className="relative size-20 shrink-0 overflow-hidden rounded-[10px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)]">
              {key ? (
                src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src}
                    {...(thumbSrcSet ? { srcSet: thumbSrcSet, sizes: "80px" } : {})}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                    onError={(e) => {
                      (
                        e.currentTarget as HTMLImageElement
                      ).style.visibility = "hidden";
                    }}
                  />
                ) : (
                  <span className="flex size-full items-center justify-center">
                    <FileIcon className="size-6 text-black/35" />
                  </span>
                )
              ) : (
                <div className="grid size-full place-items-center bg-black/[0.02] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
                  <ImageIcon className="size-5 text-black/25" />
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {key ? (
                <>
                  <span className="truncate text-[12.5px] font-medium text-black/85">
                    {key.split("/").pop()}
                  </span>
                  <span
                    className="truncate font-mono text-[11px] lowercase text-black/45"
                    title={key}
                  >
                    {key}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-[13px] text-black/55">Empty</span>
                  <span className="text-[11.5px] text-black/35">
                    Open the picker to choose a file.
                  </span>
                </>
              )}
            </div>
          </div>
        ) : null}

        {/* Manual entry — direct storage key paste, hidden until tab is active. */}
        {mode === "manual" ? (
          <div className="mt-3 flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-black/55">
              Storage key
            </label>
            <Input
              value={key}
              placeholder="e.g. core/2026/07/abc.jpg"
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
              className="h-10 rounded-[8px] font-mono text-[12px]"
            />
            <span className="text-[11px] text-black/40">
              Type or paste a R2 storage key directly.
            </span>
          </div>
        ) : null}
      </Tabs>

      <MediaPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(k) => onChange(k)}
      />
    </div>
  );
}
