import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  satisfies,
  isSupportedRange,
  readCoreApiVersion,
  checkCoreApi,
} from "./coreapi.js";

// 語意必須跟 src/ext/semver.ts 的 satisfies 一致 —— 這裡的案例刻意涵蓋 core 端的
// 判定邊界(同 major 較新 minor 相容、較舊版本不相容、跨 major 不相容)。
describe("satisfies", () => {
  it("caret:同 major、版本 >= base 才相容", () => {
    expect(satisfies("1.18.0", "^1.0.0")).toBe(true);
    expect(satisfies("1.18.0", "^1.18.0")).toBe(true);
    expect(satisfies("1.18.0", "^1.19.0")).toBe(false);
    expect(satisfies("1.18.0", "^2.0.0")).toBe(false);
    expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
  });
  it("tilde:同 major.minor", () => {
    expect(satisfies("1.18.3", "~1.18.0")).toBe(true);
    expect(satisfies("1.19.0", "~1.18.0")).toBe(false);
  });
  it(">= 與 exact", () => {
    expect(satisfies("1.18.0", ">=1.0.0")).toBe(true);
    expect(satisfies("1.18.0", ">=2.0.0")).toBe(false);
    expect(satisfies("1.18.0", "1.18.0")).toBe(true);
    expect(satisfies("1.18.0", "1.17.0")).toBe(false);
  });
  it("解析不了 → false(fail closed,與 core 相同)", () => {
    expect(satisfies("1.18.0", ">1.0.0")).toBe(false);
    expect(satisfies("1.18.0", "1.x")).toBe(false);
    expect(satisfies("1.18", "^1.0.0")).toBe(false);
    expect(satisfies("1.18.0", "")).toBe(false);
  });
});

describe("isSupportedRange", () => {
  it("認得 exact / ^ / ~ / >=", () => {
    for (const r of ["1.2.3", "^1.2.3", "~1.2.3", ">=1.2.3"]) {
      expect(isSupportedRange(r)).toBe(true);
    }
  });
  it("認不得其他形式", () => {
    for (const r of [">1.2.3", "1.x", "^1.2", "latest", ""]) {
      expect(isSupportedRange(r)).toBe(false);
    }
  });
});

describe("readCoreApiVersion", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "szws-core-"));
    await mkdir(path.join(dir, "src", "ext"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("從 src/ext/version.ts 撈出版號(前面一堆註解也不受影響)", async () => {
    await writeFile(
      path.join(dir, "src", "ext", "version.ts"),
      `// 1.9.0(…):某段註解裡也出現 CORE_API_VERSION 字樣\n` +
        `export const CORE_API_VERSION = "1.18.0";\n`,
    );
    expect(await readCoreApiVersion(dir)).toBe("1.18.0");
  });

  it("檔案不存在 → null", async () => {
    expect(await readCoreApiVersion(dir)).toBe(null);
  });

  it("檔在但沒有那個常數 → null", async () => {
    await writeFile(
      path.join(dir, "src", "ext", "version.ts"),
      `export const SOMETHING_ELSE = "1.0.0";\n`,
    );
    expect(await readCoreApiVersion(dir)).toBe(null);
  });
});

describe("checkCoreApi", () => {
  it("相容 → ok", () => {
    expect(checkCoreApi("1.18.0", "^1.5.0")).toEqual({
      status: "ok",
      core: "1.18.0",
    });
  });
  it("不相容 → incompatible", () => {
    expect(checkCoreApi("1.18.0", "^2.0.0")).toEqual({
      status: "incompatible",
      core: "1.18.0",
      unsupportedRange: false,
    });
  });
  it("range 形式看不懂 → incompatible 但標記 unsupportedRange", () => {
    expect(checkCoreApi("1.18.0", ">1.0.0")).toEqual({
      status: "incompatible",
      core: "1.18.0",
      unsupportedRange: true,
    });
  });
  it("讀不到 / 讀出怪版號 → unknown(不亂擋)", () => {
    expect(checkCoreApi(null, "^1.0.0")).toEqual({ status: "unknown" });
    expect(checkCoreApi("1.18", "^1.0.0")).toEqual({ status: "unknown" });
  });
});
