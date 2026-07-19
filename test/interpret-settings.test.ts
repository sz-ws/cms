import { describe, expect, it } from "vitest";
import { toSettingField } from "../src/ext/dx/setting-field";

describe("declarative setting interpretation", () => {
  it("preserves required into the runtime SettingField", () => {
    const field = toSettingField({
      key: "apiKey",
      label: "API key",
      type: "text",
      required: true,
      default: "",
    });
    expect(field.required).toBe(true);
  });
});
