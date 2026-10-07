"use client";

import { Component, type ReactNode } from "react";

// 一個填進插槽的元件畫壞了:只少它一個,那一頁照常 —— 跟值的插槽「出錯的跳過、其他照常」一樣。
// fallback:換掉(replace)或包起來(wrap)的元件壞掉時,改畫原本的內容。

interface SlotFillBoundaryProps {
  slot: string;
  fallback?: ReactNode;
  children?: ReactNode;
}

export class SlotFillBoundary extends Component<SlotFillBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(`[slot:${this.props.slot}] a fill failed to render`, error);
  }

  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
