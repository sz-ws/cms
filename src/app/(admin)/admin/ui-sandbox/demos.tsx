"use client";

// sandbox page 引入的 client demos。
// 這些 client component 各自持有 props/inline event handlers,
// 由 server page (ui-sandbox/page.tsx) 直接 mount,沒有 cross-boundary event 的問題。

import { UniSwapDialog } from "@/components/ui/uniswap-dialog";
import { CarouselNavigator } from "@/components/ui/carousel-navigator";
import { FeedbackAction } from "@/components/ui/feedback-action";
import { ScheduleDate } from "@/components/ui/schedule-date";
import { FluidTabs } from "@/components/ui/fluid-tabs";

export function DemoUniswap() {
  return (
    <UniSwapDialog
      value={{ name: "United States", code: "US" }}
      onChange={() => {}}
      title="Preview"
    />
  );
}

export function DemoCarousel() {
  return (
    <CarouselNavigator
      totalSlides={5}
      currentIndex={2}
      onIndexChange={() => {}}
    />
  );
}

export function DemoFeedback() {
  return (
    <FeedbackAction
      errorMessage="Sync failed"
      loadingMessage="Syncing"
      onRetry={() => {}}
    />
  );
}

export function DemoSchedule() {
  return <ScheduleDate />;
}

export function DemoTabs() {
  return <FluidTabs />;
}

// DemoStorage / DemoRevenue / DemoWeekly(widget-2/4/6)畢業移除 —— 見
// src/components/admin/dashboard/widgets/ 的正式 preset 家族。
