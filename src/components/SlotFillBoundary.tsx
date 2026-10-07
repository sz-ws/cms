"use client";

import { Component, type ReactNode } from "react";
import { isNextSignal } from "@/ext/next-signals";

// 一個填進插槽的元件在瀏覽器畫壞了:只少它一個,那一頁照常 —— 跟值的插槽「出錯的跳過、其他照常」一樣。
// fallback:換掉(replace)或包起來(wrap)的元件壞掉時,改畫原本的內容。
//
// 這是瀏覽器那一半:error boundary 在伺服器上不會動作。伺服器上壞掉的(讀資料失敗之類)由 components/Slot.tsx
// 包住填法的那一層當場接住;漏到這裡的(填的元件裡面更深的地方、client 元件)才由這裡接。
//
// redirect()、notFound() 不是畫壞(ext/next-signals.ts):原樣往上丟,不然填的元件(或被它包住的原本內容)
// 想把人帶去登入頁時,會被這裡吃掉、變成一塊空白。

interface SlotFillBoundaryProps {
  slot: string;
  fallback?: ReactNode;
  children?: ReactNode;
}

export class SlotFillBoundary extends Component<SlotFillBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(error: unknown): { failed: boolean } {
    if (isNextSignal(error)) throw error;
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(`[slot:${this.props.slot}] a fill failed to render`, error);
  }

  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
