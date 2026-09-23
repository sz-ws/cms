"use client"

import { useOptionalT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

// 24 小時制的時間欄:時、分兩個原生下拉選單。
//
// 原生 <input type="time"> 的顯示格式跟著瀏覽器語系走,不跟網站 —— 英文瀏覽器開中文
// 後台會看到「12:00 AM」。後台其他地方的時間一律 24 小時制(lib/datetime.ts 的
// hourCycle "h23"),這裡跟著一致。原生 <select> 在手機上是滾輪、桌面上是清單,
// 不需要另外寫彈出層。值的形狀和 <input type="time"> 相同("HH:MM"),可以直接替換。

const pad = (n: number) => String(n).padStart(2, "0")
const HOURS = Array.from({ length: 24 }, (_, h) => pad(h))

function parseTime(value: string): { hour: string; minute: string } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { hour: "00", minute: "00" }
  return { hour: pad(Number(m[1])), minute: m[2] }
}

function minuteOptions(step: number, current: string): string[] {
  const every = Number.isInteger(step) && step >= 1 && step <= 30 ? step : 1
  const list = Array.from({ length: Math.ceil(60 / every) }, (_, i) => pad(i * every))
  // 目前的值不在間隔上(例如 23:59 配 15 分鐘間隔)時也要列出來,不然選單會跳掉它。
  return list.includes(current) ? list : [...list, current].sort()
}

export interface TimeInputProps {
  /** "HH:MM",24 小時制。 */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** 整組的無障礙名稱,例如「發布時間」。 */
  "aria-label"?: string
  /** 分鐘選項的間隔,預設 1。 */
  minuteStep?: number
  /** 外框的樣式(背景、圓角、高度);裡面的兩個選單是透明的。 */
  className?: string
}

const SELECT_CLASS =
  "h-full cursor-pointer appearance-none rounded-[4px] bg-transparent px-1 text-center tabular-nums outline-none focus-visible:bg-black/[0.06] admin:focus-visible:bg-ink/[0.06] disabled:cursor-not-allowed"

function TimeInput({
  value,
  onChange,
  disabled,
  "aria-label": label,
  minuteStep = 1,
  className,
}: TimeInputProps) {
  const t = useOptionalT()
  const { hour, minute } = parseTime(value)

  return (
    <span
      role="group"
      aria-label={label}
      data-slot="time-input"
      className={cn("inline-flex items-center", disabled && "opacity-50", className)}
    >
      <select
        aria-label={t ? t("timeInput.hour") : "Hour"}
        value={hour}
        disabled={disabled}
        onChange={(e) => onChange(`${e.target.value}:${minute}`)}
        className={SELECT_CLASS}
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span aria-hidden="true">:</span>
      <select
        aria-label={t ? t("timeInput.minute") : "Minute"}
        value={minute}
        disabled={disabled}
        onChange={(e) => onChange(`${hour}:${e.target.value}`)}
        className={SELECT_CLASS}
      >
        {minuteOptions(minuteStep, minute).map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </span>
  )
}

export { TimeInput }
