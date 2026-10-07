import { describe, it, expect } from "vitest";
import {
  changedSettingEntries,
  keepEditsSinceSubmit,
  savedSettingsBaseline,
} from "../src/lib/settings-ui";
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

// 儲存成功之後畫面上要留什麼。等伺服器回應的那一下子,人可能已經換到別區繼續改 ——
// 那些還沒存的修改不能被「剛存好的值」蓋掉。
describe("savedSettingsBaseline / keepEditsSinceSubmit", () => {
  const submitted = {
    ...initial,
    "ext.cron.secret": "a".repeat(64),
    "ext.shop.holdMinutes": "60",
  };

  it("存好的值成為新的對照值,密鑰清空(明文不留在畫面上)", () => {
    expect(savedSettingsBaseline(sections, submitted)).toEqual({
      ...submitted,
      "ext.cron.secret": "",
    });
  });

  it("送出後沒再改:畫面值就是新的對照值,沒有東西要再存", () => {
    const baseline = savedSettingsBaseline(sections, submitted);
    const state = keepEditsSinceSubmit(submitted, submitted, baseline);
    expect(state).toEqual(baseline);
    expect(changedSettingEntries(sections, state, baseline)).toEqual({});
  });

  it("等回應時又改的欄位留著,而且算還沒存", () => {
    const baseline = savedSettingsBaseline(sections, submitted);
    const current = { ...submitted, "ext.shop.notice": "週一公休", "ext.shop.requireContact": true };
    const state = keepEditsSinceSubmit(current, submitted, baseline);
    expect(state["ext.shop.notice"]).toBe("週一公休");
    expect(state["ext.shop.requireContact"]).toBe(true);
    expect(state["ext.shop.holdMinutes"]).toBe("60");
    // 這次存進去的密鑰照樣清掉。
    expect(state["ext.cron.secret"]).toBe("");
    expect(changedSettingEntries(sections, state, baseline)).toEqual({
      "ext.shop.notice": "週一公休",
      "ext.shop.requireContact": true,
    });
  });

  it("等回應時才打的密鑰不會被清掉(它還沒存)", () => {
    const sent = { ...initial, "ext.shop.holdMinutes": "60" };
    const baseline = savedSettingsBaseline(sections, sent);
    const typedLater = { ...sent, "ext.cron.secret": "b".repeat(64) };
    const state = keepEditsSinceSubmit(typedLater, sent, baseline);
    expect(state["ext.cron.secret"]).toBe("b".repeat(64));
    expect(changedSettingEntries(sections, state, baseline)).toEqual({
      "ext.cron.secret": "b".repeat(64),
    });

    const retyped = { ...submitted, "ext.cron.secret": "c".repeat(64) };
    const again = keepEditsSinceSubmit(retyped, submitted, savedSettingsBaseline(sections, submitted));
    expect(again["ext.cron.secret"]).toBe("c".repeat(64));
  });
});
