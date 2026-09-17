import { describe, it, expect } from "vitest";
import { changedSettingEntries } from "../src/lib/settings-ui";
import type { SettingField } from "../src/lib/settings";

// 設定頁只送出改過的欄位(src/lib/settings-ui.ts)。純函式。
//
// 起因:整頁一起送時,「銀行轉帳」三個必填還空著,連 Cron 密鑰都存不進去,畫面
// 只說「一或多個設定值無效」。

const bank: SettingField[] = [
  { key: "bankName", label: "銀行名稱", type: "text", required: true, default: "" },
  { key: "accountNumber", label: "帳號", type: "text", required: true, default: "" },
];
const cron: SettingField[] = [
  { key: "secret", label: "Cron signing secret", type: "text", secret: true, default: "" },
];
const shop: SettingField[] = [
  { key: "holdMinutes", label: "付款期限", type: "number", default: 1440 },
  { key: "notice", label: "結帳頁說明", type: "textarea", default: "" },
  { key: "requireContact", label: "電話與地址必填", type: "boolean", default: false },
];
const sections = [
  { keyPrefix: "ext.banktransfer.", fields: bank },
  { keyPrefix: "ext.cron.", fields: cron },
  { keyPrefix: "ext.shop.", fields: shop },
];
const initial = {
  "ext.banktransfer.bankName": "",
  "ext.banktransfer.accountNumber": "",
  "ext.cron.secret": "",
  "ext.shop.holdMinutes": "1440",
  "ext.shop.notice": "",
  "ext.shop.requireContact": false,
};

describe("changedSettingEntries", () => {
  it("sends only the secret that was typed, not the untouched required fields elsewhere", () => {
    const state = { ...initial, "ext.cron.secret": "a".repeat(64) };
    expect(changedSettingEntries(sections, state, initial)).toEqual({
      "ext.cron.secret": "a".repeat(64),
    });
  });

  it("sends nothing when nothing changed, and never resends an empty or masked secret", () => {
    expect(changedSettingEntries(sections, initial, initial)).toEqual({});
    const masked = { ...initial, "ext.cron.secret": "•••" };
    expect(changedSettingEntries(sections, masked, initial)).toEqual({});
  });

  it("still sends a required field the user cleared, so the server can reject it", () => {
    const before = { ...initial, "ext.banktransfer.bankName": "國泰世華" };
    const after = { ...before, "ext.banktransfer.bankName": "" };
    expect(changedSettingEntries(sections, after, before)).toEqual({
      "ext.banktransfer.bankName": "",
    });
  });

  it("coerces numbers, parses JSON-looking textareas, and keeps booleans", () => {
    const state = {
      ...initial,
      "ext.shop.holdMinutes": "60",
      "ext.shop.notice": '["預購","自取"]',
      "ext.shop.requireContact": true,
    };
    expect(changedSettingEntries(sections, state, initial)).toEqual({
      "ext.shop.holdMinutes": 60,
      "ext.shop.notice": ["預購", "自取"],
      "ext.shop.requireContact": true,
    });
    const cleared = { ...initial, "ext.shop.holdMinutes": "" };
    expect(changedSettingEntries(sections, cleared, initial)).toEqual({
      "ext.shop.holdMinutes": null,
    });
  });
});
