import { useSyncExternalStore } from "react";
import { sectionAnchorId, type SettingsNavField, type SettingsNavItem } from "./settings-nav";

// 設定頁換區之後碰 DOM 的那幾件事:把焦點放到某個欄位、找出瀏覽器認為填錯的欄位、
// 讀網址的 #。從 SettingsWorkspace 拆出來,那個檔只管狀態與畫面。

/** 區的標題的 DOM id:要去的欄位不在畫面上時,焦點落在這裡。 */
export function sectionTitleId(id: string): string {
  return `${sectionAnchorId(id)}-title`;
}

/** 換區之後要做的事:把新的一區帶回畫面裡,或把焦點放到指定的欄位上。 */
export type RevealRequest =
  | { kind: "section" }
  | { kind: "field"; controlId: string; fallbackId: string };

export function fieldReveal(item: SettingsNavItem, field: SettingsNavField): RevealRequest {
  return { kind: "field", controlId: field.controlId, fallbackId: sectionTitleId(item.id) };
}

const FOCUSABLE =
  "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])";

/**
 * 把焦點放到某個設定的輸入框上,並捲到畫面中間。分頁與色票的 id 掛在整組按鈕外面:
 * 焦點落在選中的那一顆。欄位不在畫面上(showWhen 不成立)時落在 fallbackId。
 */
export function focusSettingControl(controlId: string, fallbackId: string): void {
  const control = document.getElementById(controlId);
  const target = !control
    ? document.getElementById(fallbackId)
    : control.matches(FOCUSABLE)
      ? control
      : (control.querySelector<HTMLElement>('[tabindex="0"]') ??
        control.querySelector<HTMLElement>('[aria-checked="true"]') ??
        control.querySelector<HTMLElement>(FOCUSABLE) ??
        control);
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  target.focus({ preventScroll: true });
}

type ValidatedControl = HTMLInputElement | HTMLTextAreaElement;

/**
 * 畫面上那一區的欄位([data-settings-fields])裡,瀏覽器認為填錯的第一個
 * (數字框打了不是數字的字、日期只填一半)。有自己儲存鈕的區塊不算:它們不歸整頁的儲存管。
 * 下拉選單不必看:設定頁的選單不是原生 <select>,也沒有會讓它不合格的條件。
 */
export function firstInvalidControl(form: HTMLFormElement): ValidatedControl | null {
  const controls = form.querySelectorAll<ValidatedControl>(
    "[data-settings-fields] input, [data-settings-fields] textarea",
  );
  return Array.from(controls).find((control) => control.willValidate && !control.validity.valid) ?? null;
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function readHash(): string {
  return window.location.hash;
}

function noHash(): string {
  return "";
}

/** 網址的 #(含井字號;沒有就是空字串)。伺服器看不到 #,所以伺服器那一次是空的。 */
export function useLocationHash(): string {
  return useSyncExternalStore(subscribeToHash, readHash, noHash);
}
