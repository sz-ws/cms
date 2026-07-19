import { describe, expect, it } from "vitest";
import { settingControlId } from "../src/lib/settings-ui";

describe("settings control accessibility ids", () => {
  it("produces stable HTML-safe ids from persisted setting keys", () => {
    expect(settingControlId("core.siteTitle")).toBe("setting-core-siteTitle");
    expect(settingControlId("ext.demo.apiKey")).toBe("setting-ext-demo-apiKey");
  });
});
