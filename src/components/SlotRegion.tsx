"use client";

import type { ReactNode } from "react";
import type { SlotParts } from "@/ext/slots";
import { SlotFillBoundary } from "./SlotFillBoundary";

// client 元件裡的插槽(機制見 src/ext/slots.ts、components/Slot.tsx)。parts 是外層的伺服器元件用
// slotParts() 準備好傳進來的;沒有傳(頁面沒開這個插槽)就只畫預設內容。

export function SlotRegion({ parts, children }: { parts?: SlotParts; children?: ReactNode }): ReactNode {
  if (!parts) return children;
  let content: ReactNode = (
    <>
      {parts.before}
      {parts.replace ? (
        <SlotFillBoundary slot={parts.slot} fallback={children}>
          {parts.replace}
        </SlotFillBoundary>
      ) : (
        children
      )}
      {parts.after}
    </>
  );
  for (const Wrap of parts.wrap) {
    content = (
      <SlotFillBoundary slot={parts.slot} fallback={content}>
        <Wrap {...parts.props}>{content}</Wrap>
      </SlotFillBoundary>
    );
  }
  return content;
}
