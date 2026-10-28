import { describe, it, expect } from "vitest";
import { isNewerVersion, rangeStartsAtOrAfter, satisfies } from "../src/ext/semver";

// core-v2 §1 semver range checker 的純邏輯測試(試水:確認測試棧能跑)。
describe("semver satisfies", () => {
  it("exact match", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3")).toBe(false);
  });

  it("caret (^) stays within same major", () => {
    expect(satisfies("1.5.0", "^1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "^1.2.3")).toBe(true);
    expect(satisfies("1.2.2", "^1.2.3")).toBe(false); // below floor
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false); // different major
  });

  it("tilde (~) stays within same major.minor", () => {
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
  });

  it("gte (>=)", () => {
    expect(satisfies("1.2.3", ">=1.2.3")).toBe(true);
    expect(satisfies("2.0.0", ">=1.2.3")).toBe(true);
    expect(satisfies("1.2.2", ">=1.2.3")).toBe(false);
  });

  it("fails closed on unparseable input", () => {
    expect(satisfies("nope", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.0", "garbage")).toBe(false);
    expect(satisfies("1.0", "1.0.0")).toBe(false); // not x.y.z
  });

  it("real registry manifests resolve against CORE_API 1.3.0", () => {
    expect(satisfies("1.3.0", "^1.0.0")).toBe(true); // gallery
    expect(satisfies("1.3.0", "^1.1.0")).toBe(true); // blog
  });
});

describe("rangeStartsAtOrAfter", () => {
  it.each(["^1.17.0", "~1.17.0", ">=1.17.0", "1.17.0", "~1.16.0", "1.16.0"])(
    "rejects older base range %s",
    (range) => {
      expect(rangeStartsAtOrAfter(range, "1.18.0")).toBe(false);
    },
  );

  it.each(["^1.18.0", "~1.18.0", ">=1.18.0", "1.18.0", "^2.0.0"])(
    "accepts base range %s",
    (range) => {
      expect(rangeStartsAtOrAfter(range, "1.18.0")).toBe(true);
    },
  );
});

describe("isNewerVersion", () => {
  it("逐段比大小,不是比字串", () => {
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(false);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
  });

  it("相同或比較舊都不算新(registry 落後時不提示更新)", () => {
    expect(isNewerVersion("1.0.3", "1.0.3")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.3")).toBe(false);
  });

  it("任一邊不是 x.y.z:退回「不相同就算新」", () => {
    expect(isNewerVersion("1.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "")).toBe(true);
    expect(isNewerVersion("dev", "dev")).toBe(false);
  });
});
