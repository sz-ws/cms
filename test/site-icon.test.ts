import { describe, expect, it } from "vitest";
import { siteIconHref } from "../src/lib/site-icon";
import { CORE_SETTINGS } from "../src/lib/settings";

// 網站圖示(1.68.0 core.siteIcon):設定值會寫進 <link rel="icon" href>,只收站內路徑與 https 網址。

describe("siteIconHref", () => {
  it("收站內路徑與 https 網址", () => {
    expect(siteIconHref("/api/files/core/2026/10/icon.png")).toBe("/api/files/core/2026/10/icon.png");
    expect(siteIconHref("  https://example.com/icon.png ")).toBe("https://example.com/icon.png");
  });

  it("沒填、不是字串、其他寫法都當沒設", () => {
    for (const value of ["", "   ", undefined, null, 42, "icon.png", "http://example.com/icon.png"]) {
      expect(siteIconHref(value)).toBeNull();
    }
  });

  it("不收會跑到別的網站或執行程式的網址", () => {
    for (const value of ["//evil.example/icon.png", "/\\evil.example/icon.png", "javascript:alert(1)", "data:image/png;base64,AAAA"]) {
      expect(siteIconHref(value)).toBeNull();
    }
  });
});

describe("core.siteIcon", () => {
  it("在一般設定裡,預設留空", () => {
    const field = CORE_SETTINGS.find((f) => f.key === "core.siteIcon");
    expect(field?.group).toBe("general");
    expect(field?.default).toBe("");
  });
});
