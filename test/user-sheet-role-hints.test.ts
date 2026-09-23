import { describe, expect, it } from "vitest";
import { zhHant } from "../src/lib/i18n/zh-hant";

// 成員編輯面板的角色說明:中文寫在一行放得下的長度(面板 25rem 寬、11.5px 字約 26 字)。
// 超過就會折行,最後一行常常只剩「放。」這種一兩個字(見 UserSheet 的註解)。

describe("member sheet role hints", () => {
  it.each(["userSheet.roleAdminHint", "userSheet.roleEditorHint", "userSheet.roleGuestHint"] as const)(
    "%s 放得進一行",
    (key) => {
      const hint = zhHant[key] ?? "";
      expect(hint.length).toBeGreaterThan(0);
      expect(hint.length).toBeLessThanOrEqual(25);
    },
  );
});
