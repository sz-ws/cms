"use client";

import { useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, ImagePlusIcon, XIcon } from "lucide-react";
import { MediaImage } from "@/components/ui/media-image";
import { MediaPickerDialog } from "./MediaPickerDialog";
import { GALLERY_MAX } from "../media-key";
import { useExtT } from "../ext-locale";
import type { FieldComponentProps } from "./types";

// 1.66.0:gallery 欄位(多張圖)。存的值 = 有序的 media key 陣列,順序就是畫面上的順序。
//
// 「加入圖片」打開同一個 MediaPickerDialog 的多選模式:媒體庫點選或一次上傳好幾張,照順序
// 接在最後面。每張縮圖底下有往前、往後、移除;長圖的縮圖從最上面裁,看得出是哪一張。
// 上限是欄位的 max(沒寫 = GALLERY_MAX),滿了「加入圖片」就停用。

const TILE_BUTTON =
  "grid size-8 place-items-center rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] text-black/60 admin:text-ink/60 transition-[color,background-color] outline-none hover:bg-black/[0.05] admin:hover:bg-ink/[0.05] hover:text-black/90 admin:hover:text-ink/90 focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--admin-accent)_45%,transparent)] active:scale-[0.94] disabled:pointer-events-none disabled:opacity-30 motion-reduce:active:scale-100";

/** 把 index 那一張往前(-1)或往後(+1)換一格;回傳新陣列。 */
export function moveKey(keys: readonly string[], index: number, step: -1 | 1): string[] {
  const target = index + step;
  if (index < 0 || index >= keys.length || target < 0 || target >= keys.length) return [...keys];
  const next = [...keys];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function GalleryField({ value, onChange, field, error, disabled }: FieldComponentProps<string[]>) {
  const keys = Array.isArray(value) ? value : [];
  const max = field.max ?? GALLERY_MAX;
  const room = max - keys.length;
  const [pickerOpen, setPickerOpen] = useState(false);
  const t = useExtT();

  return (
    <div className="flex flex-col gap-3" id={`field-${field.key}`}>
      <div className="flex items-center justify-end gap-3">
        <span className="text-[12px] tabular-nums text-black/45 admin:text-ink/45">
          {t("dxField.gallery.count", { n: keys.length, max })}
        </span>
        <button
          type="button"
          disabled={disabled || room <= 0}
          onClick={() => setPickerOpen(true)}
          data-invalid={error ? "true" : undefined}
          className="inline-flex h-10 items-center gap-1.5 rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] bg-black admin:bg-ink px-4 text-[13px] font-medium text-white transition-[background-color] outline-none hover:bg-black/85 admin:hover:bg-ink/85 focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.25)] active:scale-[0.96] disabled:opacity-40 motion-reduce:active:scale-100 data-[invalid]:shadow-[0_0_0_1px_rgba(185,28,28,0.5)]"
        >
          <ImagePlusIcon className="size-4" />
          {t("dxField.gallery.add")}
        </button>
      </div>

      {keys.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-[14px] admin:rounded-[calc(14px*var(--admin-radius-scale,1))] bg-black/[0.02] admin:bg-ink/[0.02] px-6 py-8 text-center shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]">
          <span className="text-[13px] font-medium text-black/60 admin:text-ink/60">{t("dxField.gallery.empty")}</span>
          <span className="text-[12px] text-black/40 admin:text-ink/40">{t("dxField.gallery.emptyHint")}</span>
        </div>
      ) : (
        <ol className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {keys.map((key, index) => (
            <li
              key={`${key}-${index}`}
              className="flex flex-col overflow-hidden rounded-[12px] admin:rounded-[calc(12px*var(--admin-radius-scale,1))] bg-white admin:bg-surface shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_1px_2px_-1px_rgba(0,0,0,0.06)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.07),0_1px_2px_-1px_rgba(0,0,0,0.06))]"
            >
              <div className="relative aspect-square bg-black/[0.03] admin:bg-ink/[0.03]">
                <MediaImage
                  mediaKey={key}
                  alt=""
                  maxWidth={320}
                  sizes="(min-width: 640px) 160px, 45vw"
                  className="absolute inset-0 size-full object-cover object-top"
                />
                <span className="absolute top-1.5 left-1.5 grid min-w-6 place-items-center rounded-full bg-white/90 px-1.5 text-[12px] font-semibold tabular-nums text-black/75 shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
                  {index + 1}
                </span>
              </div>
              <div className="flex items-center justify-between px-1 py-1">
                <span className="flex">
                  <button
                    type="button"
                    className={TILE_BUTTON}
                    disabled={disabled || index === 0}
                    aria-label={t("dxField.gallery.moveEarlier", { n: index + 1 })}
                    onClick={() => onChange(moveKey(keys, index, -1))}
                  >
                    <ChevronLeftIcon className="size-4" />
                  </button>
                  <button
                    type="button"
                    className={TILE_BUTTON}
                    disabled={disabled || index === keys.length - 1}
                    aria-label={t("dxField.gallery.moveLater", { n: index + 1 })}
                    onClick={() => onChange(moveKey(keys, index, 1))}
                  >
                    <ChevronRightIcon className="size-4" />
                  </button>
                </span>
                <button
                  type="button"
                  className={TILE_BUTTON}
                  disabled={disabled}
                  aria-label={t("dxField.gallery.remove", { n: index + 1 })}
                  onClick={() => onChange(keys.filter((_, i) => i !== index))}
                >
                  <XIcon className="size-4" />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <MediaPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(key) => onChange([...keys, key].slice(0, max))}
        onSelectMany={(added) => onChange([...keys, ...added].slice(0, max))}
        limit={room}
      />
    </div>
  );
}
