import { describe, it, expect } from "vitest";
import { judge, varIsSet } from "./preflight.js";
import { normalizeSetting, type SettingField } from "./settings.js";

function field(overrides: Partial<SettingField> & { key: string }): SettingField {
  const base = normalizeSetting({
    key: overrides.key,
    label: overrides.label ?? overrides.key,
    type: overrides.type ?? "text",
    default: "",
    ...(overrides.type === "select" ? { options: [{ value: "a" }] } : {}),
  });
  if (!base) throw new Error("bad fixture");
  return { ...base, ...overrides };
}

describe("varIsSet", () => {
  it("鍵不存在 / 空字串 / null 一律算沒設定", () => {
    const vars = new Map<string, unknown>([
      ["A", "x"],
      ["B", ""],
      ["C", null],
      ["D", 0],
      ["E", false],
    ]);
    expect(varIsSet(vars, "A")).toBe(true);
    expect(varIsSet(vars, "B")).toBe(false);
    expect(varIsSet(vars, "C")).toBe(false);
    // 0 / false 是**真的值**,不是「沒填」。
    expect(varIsSet(vars, "D")).toBe(true);
    expect(varIsSet(vars, "E")).toBe(true);
    expect(varIsSet(vars, "Z")).toBe(false);
  });
});

describe("judge", () => {
  const vars = new Map<string, unknown>([["EXT_DEMO_TOKEN", "abc"]]);

  it("非 secret 有值 → ok", () => {
    expect(judge("demo", field({ key: "token" }), vars, []).verdict).toBe("ok");
  });

  it("非 secret、必填、vars 沒有 → missing", () => {
    const row = judge("demo", field({ key: "other", required: true }), vars, []);
    expect(row.verdict).toBe("missing");
    expect(row.storage).toBe("vars");
  });

  it("非 secret、非必填、vars 沒有 → 只算無法驗證(可能 deploy 後在 admin 填)", () => {
    const row = judge("demo", field({ key: "other" }), vars, []);
    expect(row.verdict).toBe("unverifiable");
    expect(row.reason).toMatch(/admin/);
  });

  it("secret 在帳號上 → ok;不在且必填 → missing", () => {
    const secretField = field({ key: "apiKey", secret: true, required: true });
    expect(judge("demo", secretField, vars, ["EXT_DEMO_API_KEY"]).verdict).toBe("ok");
    expect(judge("demo", secretField, vars, []).verdict).toBe("missing");
  });

  it("secret 清單查不到(null)→ 一律無法驗證,絕不報成 missing", () => {
    const row = judge("demo", field({ key: "apiKey", secret: true, required: true }), vars, null);
    expect(row.verdict).toBe("unverifiable");
    expect(row.reason).toMatch(/could not be read/);
  });
});
