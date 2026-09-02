"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { RotateCcw, ScrollText } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";
import { clearStoredTranscript, transcriptStorageKey } from "./persist";
import type { AgentPanelStatus } from "./AgentPanel";
import type { AgentToolSummary } from "./tools";

// docs/spec-admin-agent.md §5:面板的載入點 + 頁首那一行。
//
// ── 為什麼有這一層 ──────────────────────────────────────────────────────────
// 原本的唯一理由是**打包隔離**:AgentPanel 這條相依鏈會拉進 motion、streamdown 與
// 整組對話元件,而 spec §5 明定它不進全站 bundle(性能預算照舊)。next/dynamic 需要
// client component 才能用 ssr:false,所以 server 的 page.tsx 經這一層薄殼進來。
//
// ssr:false 也順帶解掉一件事:面板第一畫面沒有任何 server 能算出來的內容
// (transcript 住 localStorage,server 讀不到),SSR 它只是多送一份會被立刻丟掉的
// HTML。
//
// ── 為什麼「開新對話」住這裡 ────────────────────────────────────────────────
// 兩件事同時成立才有這個安排:
//
//   1. **這一層不是 lazy 的**(走 next/dynamic 的只有 AgentPanel)。所以標題會跟著
//      頁面一起出現,不會等 chunk 載完才突然跳出來 —— 一個會遲到的 <h1> 是最糟的
//      版面跳動。標題字由 page.tsx 以 prop 傳進來(那邊本來就有 server 端的
//      getMessages),它因此是第一份 HTML 就帶著的字,不必等任何 client 端的東西。
//   2. **「開新對話」= 換掉 AgentPanel 的 key**,讓它整個 remount。比把一個
//      onNewChat 搬進面板乾淨的地方在於:remount 不需要有人記得「還有哪些 state
//      要清」。busy / executing / transport / streaming / abortRef 之外,未來還會
//      再長出東西;而面板既有的 unmount effect(abortRef.current?.abort())也會
//      順手中止進行中的 /chat,不必在這裡重講一次那條規則。
//
// 按鈕擺在標題那一行是**零額外高度**:它的盒高 11.5px×1.5 + py-1×2 ≈ 25px,比
// 21px×1.5 ≈ 31.5px 的 <h1> 行盒還矮,所以整行的高度仍由標題決定。原本它佔的是
// composer 底下**多出來的一列** —— 拿掉之後那一列直接還給對話區。
//
// ── 面板高度 h-[calc(100dvh-9.75rem)] 的推導 ────────────────────────────────
//   AdminNav            h-14              3.5rem   / 56px   (AdminNav.tsx)
//   main 的上下 padding  lg:p-6            3rem     / 48px   (AdminShell.tsx)
//   頁面 gap-5(標題行 ↔ 面板)            1.25rem  / 20px   (page.tsx)
//   標題行(21px × 1.5,Tailwind preflight 的 html line-height)
//                                         1.96875rem / 31.5px
//   ───────────────────────────────────────────────────────────
//   合計 155.5px ≈ 9.72rem → 取 **9.75rem**(往上取到最近的 1/4 rem:寧可矮 4px,
//   也不要因為算得剛剛好而多出一條 4px 的頁面捲軸)。
//
// 舊的 11rem 是**副標還在**時的數字:副標(12px × 1.5 = 18px)+ gap-1(4px)= 22px,
// 加回去正好 177.5px ≈ 11.09rem —— 推導對得上,所以副標拿掉之後那 22px 本來就該
// 還給對話區。lg 以下 main 是 p-4(少 1rem),面板因此會比可用空間再矮 1rem;那是
// 這個常數從一開始就有的保守偏差,不在這次的改動範圍。
//
// 為什麼仍是常數而不是 flex 滿版鏈:SidebarInset → main 這條祖先鏈沒有 h-screen +
// min-h-0,要改成滿版得動 AdminShell,而那是整個後台共用的版型 —— 不為了一頁去動它。

/** 面板與它的載入佔位共用同一個高度(對不上的話 chunk 載完會跳一下)。 */
const PANEL_HEIGHT = "h-[calc(100dvh-9.75rem)] min-h-[26rem]";

const AgentPanel = dynamic(
  () => import("./AgentPanel").then((m) => m.AgentPanel),
  {
    ssr: false,
    // 載入中的佔位:安靜的骨架,不是 kit spinner(admin-design-language.md)。
    loading: () => (
      <div aria-hidden className={`${PANEL_HEIGHT} rounded-[14px] bg-black/[0.015]`} />
    ),
  },
);

interface AgentPanelLoaderProps {
  tools: AgentToolSummary[];
  /** 頁首標題。由 page.tsx 的 server 端 getMessages 傳下來(見檔頭)。 */
  title: string;
  /** 目前登入者的 id;localStorage 的 key 綁它(見 ./persist.ts)。 */
  userId: string;
}

export function AgentPanelLoader({ tools, title, userId }: AgentPanelLoaderProps) {
  const t = useT();
  const [resetKey, setResetKey] = useState(0);
  const [status, setStatus] = useState<AgentPanelStatus>({
    hasContent: false,
    busy: false,
  });

  // 值一樣就不換物件:面板每次 render 後都會回報一次,照單全收會讓這一層跟著空轉。
  const onStatusChange = useCallback((next: AgentPanelStatus) => {
    setStatus((prev) =>
      prev.hasContent === next.hasContent && prev.busy === next.busy ? prev : next,
    );
  }, []);

  function onNewChat(): void {
    if (status.busy) return;
    // **先清 storage 再 remount**。順序不能反:remount 後的面板會在自己的 useState
    // initializer 裡讀 localStorage,先 remount 等於把剛剛想丟掉的那份對話讀回來。
    clearStoredTranscript(transcriptStorageKey(userId));
    setResetKey((key) => key + 1);
    // 新面板掛載後也會回報一次空狀態,但那要等到 effect 跑完;先在這裡歸零,按鈕
    // 才不會在換頁的那一格畫面裡還留著。
    setStatus({ hasContent: false, busy: false });
  }

  return (
    <>
      {/* 標題與按鈕同一行,items-center 讓矮的按鈕在標題行盒裡置中。
          -mr-1 抵掉按鈕自己的 px-1:視覺上要對齊的是**文字**的右緣,不是那塊
          為了好按而留的 padding。 */}
      <div className="mx-auto flex w-full max-w-[46rem] items-center justify-between gap-3">
        <h1 className="text-[21px] font-semibold tracking-[-0.015em] text-black/90">
          {title}
        </h1>
        <div className="flex items-center gap-3">
          {/* 稽核頁入口。永遠顯示(不像「開新對話」只在有內容時出現):它指向的是
              整個站的紀錄,與這一段對話有沒有內容無關。 */}
          <Link
            href="/admin/agent/audit"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[8px] px-1 py-1 text-[11.5px] text-black/35 transition-colors duration-150 hover:text-black/70"
          >
            <ScrollText className="size-3" />
            {t("agent.audit.link")}
          </Link>
        {status.hasContent && (
          <button
            type="button"
            onClick={onNewChat}
            disabled={status.busy}
            className="-mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-[8px] px-1 py-1 text-[11.5px] text-black/35 transition-colors duration-150 hover:text-black/70 disabled:opacity-40"
          >
            <RotateCcw className="size-3" />
            {t("agent.newChat")}
          </button>
        )}
        </div>
      </div>

      <AgentPanel
        key={resetKey}
        tools={tools}
        userId={userId}
        onStatusChange={onStatusChange}
      />
    </>
  );
}
