import { cn } from "@/lib/utils";

// 1.40.0:後台與插件共用的「載入中」。以前各頁自己在左上角放一行灰字,有的換了
// 灰色 spinner;現在一律置中、轉圈吃後台主色(--admin-accent)。
//
// - 不依賴 i18n context:插件的工作區也用在前台(會員查單),那裡沒有 I18nProvider,
//   所以文字由呼叫端給(後台 core 傳 t("admin.loading"))。
// - 只轉圈,不閃爍、不呼吸(專案紅線);偏好減少動態時轉慢,仍看得出在忙。
// - 晚 120ms 淡入:快的請求不會先閃一下 spinner 再換成內容。

/** 吃主色的轉圈(淡色軌道 + 主色弧)。 */
export function AccentSpinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn("size-5 animate-spin motion-reduce:animate-[spin_2.4s_linear_infinite]", className)}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        strokeWidth="2.5"
        style={{ stroke: "color-mix(in srgb, var(--admin-accent) 16%, transparent)" }}
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        style={{ stroke: "var(--admin-accent)" }}
      />
    </svg>
  );
}

export function LoadingState({
  label,
  size = "page",
  className,
}: {
  /** 顯示在轉圈下方,也是讀屏念的內容,如「載入中…」。 */
  label: string;
  /** page:佔住內容區、畫面置中;inline:區塊裡(如明細面板的一段)置中。 */
  size?: "page" | "inline";
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex w-full flex-col items-center justify-center gap-3",
        "animate-[cms-loading-in_200ms_ease-out_120ms_both]",
        size === "page" ? "min-h-[45vh]" : "py-6",
        className,
      )}
    >
      <AccentSpinner className={size === "page" ? "size-6" : "size-5"} />
      <span className="text-[12.5px] text-ink/40">{label}</span>
    </div>
  );
}
