"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { hexToHsv, hsvToHex, normalizeHex, readableOn, type Hsv } from "@/lib/color";
import { useT } from "@/lib/i18n/I18nProvider";

// 顏色欄位:一排圓形色票,最後一顆是自訂。設定頁的 setting type "color" 與後台風格都用這個。
//
// 自訂色盤是自己畫的,沒有另外裝套件:飽和度/明度方塊 + 色相滑桿 + hex 輸入。
// 方塊用方向鍵調(Shift 一次 10),色相是原生 range,鍵盤與讀屏都不用另外處理。

export interface ColorSwatch {
  value: string;
  label: string;
}

interface ColorSwatchPickerProps {
  id?: string;
  value: string;
  onChange: (hex: string) => void;
  swatches: ColorSwatch[];
  /** 整組色票的無障礙名稱(通常就是欄位標籤)。 */
  label: string;
  invalid?: boolean;
}

// 內圈用卡片色,不寫死白色:後台風格可以把卡片換成米色、淡綠。
const RING_SELECTED = "shadow-[0_0_0_2px_var(--admin-surface,#fff),0_0_0_4px_rgba(0,0,0,0.75)]";
const RING_IDLE = "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] hover:shadow-[0_0_0_2px_var(--admin-surface,#fff),0_0_0_4px_rgba(0,0,0,0.18)]";
const DOT = "relative flex size-7 shrink-0 items-center justify-center rounded-full transition-shadow duration-150 outline-none focus-visible:shadow-[0_0_0_2px_var(--admin-surface,#fff),0_0_0_4px_rgba(0,0,0,0.45)]";

export function ColorSwatchPicker({ id, value, onChange, swatches, label, invalid }: ColorSwatchPickerProps) {
  const current = normalizeHex(value);
  const custom = current !== null && !swatches.some((s) => normalizeHex(s.value) === current);

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      aria-invalid={invalid || undefined}
      className="flex flex-wrap items-center gap-2.5 py-1"
    >
      {swatches.map((swatch) => {
        const hex = normalizeHex(swatch.value) ?? swatch.value;
        const selected = hex === current;
        return (
          <button
            key={hex}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={swatch.label}
            title={swatch.label}
            onClick={() => onChange(hex)}
            className={cn(DOT, selected ? RING_SELECTED : RING_IDLE)}
            style={{ backgroundColor: hex }}
          >
            {selected ? <Check aria-hidden className="size-3.5" style={{ color: readableOn(hex) }} /> : null}
          </button>
        );
      })}
      <CustomSwatch value={custom ? current : null} fallback={current ?? swatches[0]?.value ?? "#5672e4"} onChange={onChange} />
    </div>
  );
}

function CustomSwatch({
  value,
  fallback,
  onChange,
}: {
  /** 目前選的是自訂色時的值;選的是預設色票時 null。 */
  value: string | null;
  /** 打開色盤時的起點。 */
  fallback: string;
  onChange: (hex: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const selected = value !== null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={t("color.custom")}
        title={t("color.custom")}
        className={cn(DOT, selected ? RING_SELECTED : RING_IDLE)}
        style={
          selected
            ? { backgroundColor: value }
            : { backgroundImage: "conic-gradient(from 90deg, #f43f5e, #f59e0b, #84cc16, #10b981, #06b6d4, #6366f1, #d946ef, #f43f5e)" }
        }
      >
        {selected ? (
          <Check aria-hidden className="size-3.5" style={{ color: readableOn(value) }} />
        ) : (
          <span aria-hidden className="size-3 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)]" />
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3">
        {/* 每次打開從目前的顏色起算。 */}
        {open ? <CustomPanel initial={value ?? fallback} onChange={onChange} /> : null}
      </PopoverContent>
    </Popover>
  );
}

function CustomPanel({ initial, onChange }: { initial: string; onChange: (hex: string) => void }) {
  const t = useT();
  // 在 HSV 裡操作:hex 轉回來時灰色會丟掉色相,拖到灰再拖回來不能跳色。
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(initial));
  const [draft, setDraft] = useState(normalizeHex(initial) ?? initial);
  const area = useRef<HTMLDivElement>(null);

  function commit(next: Hsv) {
    setHsv(next);
    const hex = hsvToHex(next);
    setDraft(hex);
    onChange(hex);
  }

  function fromPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = area.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
    commit({ ...hsv, s: Math.round((x / rect.width) * 100), v: Math.round(100 - (y / rect.height) * 100) });
  }

  function onAreaKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const d = delta[event.key];
    if (!d) return;
    event.preventDefault();
    commit({
      ...hsv,
      s: Math.min(Math.max(hsv.s + d[0], 0), 100),
      v: Math.min(Math.max(hsv.v + d[1], 0), 100),
    });
  }

  function commitDraft() {
    const hex = normalizeHex(draft);
    if (!hex) {
      setDraft(hsvToHex(hsv));
      return;
    }
    setHsv(hexToHsv(hex));
    setDraft(hex);
    onChange(hex);
  }

  return (
    <div className="flex w-[216px] flex-col gap-3">
      <div
        ref={area}
        role="slider"
        tabIndex={0}
        aria-label={t("color.area")}
        aria-valuetext={t("color.areaValue", { s: hsv.s, v: hsv.v })}
        aria-valuenow={hsv.s}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          fromPointer(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event);
        }}
        onKeyDown={onAreaKey}
        className="relative h-[140px] w-full cursor-crosshair touch-none rounded-[8px] outline-none focus-visible:shadow-[0_0_0_2px_var(--admin-surface,#fff),0_0_0_4px_rgba(0,0,0,0.45)]"
        style={{
          backgroundColor: `hsl(${hsv.h} 100% 50%)`,
          backgroundImage: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
        }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_#fff,0_1px_3px_rgba(0,0,0,0.4)]"
          style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, backgroundColor: hsvToHex(hsv) }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={359}
        value={hsv.h}
        aria-label={t("color.hue")}
        onChange={(event) => commit({ ...hsv, h: Number(event.target.value) })}
        className={cn(
          "h-3 w-full cursor-pointer appearance-none rounded-full outline-none",
          "[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full",
          "[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_rgba(0,0,0,0.2),0_1px_3px_rgba(0,0,0,0.3)]",
          "[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white",
          "focus-visible:shadow-[0_0_0_2px_var(--admin-surface,#fff),0_0_0_4px_rgba(0,0,0,0.45)]",
        )}
        style={{
          background:
            "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
        }}
      />
      <label className="flex items-center gap-2 text-[12px] text-ink/45">
        <span
          aria-hidden
          className="size-7 shrink-0 rounded-[6px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]"
          style={{ backgroundColor: hsvToHex(hsv) }}
        />
        <span className="sr-only">{t("color.hex")}</span>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              commitDraft();
            }
          }}
          spellCheck={false}
          maxLength={7}
          className="h-8 w-full rounded-[8px] bg-surface px-2.5 font-mono text-[13px] text-ink/80 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]"
        />
      </label>
    </div>
  );
}
