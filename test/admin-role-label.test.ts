import { describe, expect, it } from "vitest";
import { getMessages } from "../src/lib/i18n/index";
import { roleLabel } from "../src/components/admin/role-label";

// 側欄使用者區塊、帳號選單與帳戶頁顯示的角色名稱:不能是 "admin" 這類內部代碼。

const zh = getMessages("zh-Hant");
const en = getMessages("en");
const tZh = (key: keyof typeof zh) => zh[key];
const tEn = (key: keyof typeof en) => en[key];

describe("roleLabel", () => {
  it("預設角色走 i18n", () => {
    expect(roleLabel({ role: "admin" }, tZh)).toBe("管理員");
    expect(roleLabel({ role: "editor" }, tZh)).toBe("工作人員");
    expect(roleLabel({ role: "guest" }, tZh)).toBe("訪客");
    expect(roleLabel({ role: "admin" }, tEn)).toBe("Admin");
  });

  it("自訂角色用它自己的名字,即使當下的 role 是 admin", () => {
    const staffRole = { id: "r1", name: "會計" };
    expect(roleLabel({ role: "admin", staffRole }, tZh)).toBe("會計");
    expect(roleLabel({ role: "editor", staffRole }, tZh)).toBe("會計");
  });
});
