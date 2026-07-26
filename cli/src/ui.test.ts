import { describe, it, expect } from "vitest";
import {
  createAutoPrompter,
  createReporter,
  makeStyles,
  type Reporter,
} from "./ui.js";

function capture(animate = false): { reporter: Reporter; out: () => string } {
  let buf = "";
  const reporter = createReporter({
    write: (c) => {
      buf += c;
    },
    animate,
    styles: makeStyles(false),
  });
  return { reporter, out: () => buf };
}

describe("makeStyles", () => {
  it("關閉時完全不吐控制碼(被導向檔案 / NO_COLOR)", () => {
    const s = makeStyles(false);
    expect(s.green("ok")).toBe("ok");
    expect(s.bold("t")).toBe("t");
    expect(s.red("x")).not.toMatch(/\u001b/);
  });

  it("開啟時包上 ANSI 前後綴", () => {
    expect(makeStyles(true).green("ok")).toBe("\u001b[32mok\u001b[0m");
  });
});

describe("createReporter", () => {
  it("每種狀態有各自的符號", () => {
    const { reporter, out } = capture();
    reporter.step("ok", "成功");
    reporter.step("skip", "略過");
    reporter.step("todo", "要做");
    reporter.step("warn", "注意");
    reporter.step("fail", "失敗");
    expect(out()).toBe("✓ 成功\n• 略過\n→ 要做\n⚠ 注意\n✗ 失敗\n");
  });

  it("detail 縮排在第二行", () => {
    const { reporter, out } = capture();
    reporter.step("ok", "建立 D1", "uuid-here");
    expect(out()).toBe("✓ 建立 D1\n  uuid-here\n");
  });

  it("intro / note / outro 的排版", () => {
    const { reporter, out } = capture();
    reporter.intro("標題", "副標");
    reporter.note("清單", ["一", "二"]);
    reporter.outro(["結束"]);
    expect(out()).toBe("\n標題\n副標\n\n\n清單\n  一\n  二\n\n結束\n");
  });

  it("task 在非動畫模式下退化成純文字,回傳值原樣傳出", async () => {
    const { reporter, out } = capture(false);
    await expect(reporter.task("做事", async () => 42)).resolves.toBe(42);
    expect(out()).toBe("… 做事\n");
    // 非 TTY 絕不能吐轉圈的控制碼,否則被導向的輸出會塞滿垃圾。
    expect(out()).not.toMatch(/\u001b/);
  });

  it("task 丟例外時往上傳,不吞掉", async () => {
    const { reporter } = capture(false);
    await expect(
      reporter.task("炸", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("動畫模式結束後會清掉那一行", async () => {
    const { reporter, out } = capture(true);
    await reporter.task("做事", async () => 1);
    expect(out()).toContain("\r\u001b[2K");
  });
});

describe("createAutoPrompter", () => {
  it("不問任何問題,直接用預設值(非互動 / CI 用)", async () => {
    const seen: [string, string][] = [];
    const p = createAutoPrompter((q, a) => seen.push([q, a]));
    await expect(p.confirm("要嗎?", true)).resolves.toBe(true);
    await expect(p.confirm("要嗎?", false)).resolves.toBe(false);
    await expect(p.text("名字?", "cms")).resolves.toBe("cms");
    await expect(p.text("沒預設?")).resolves.toBe("");
    await expect(
      p.select("挑一個", [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ]),
    ).resolves.toBe("a");
    expect(seen.map(([q]) => q)).toEqual([
      "要嗎?",
      "要嗎?",
      "名字?",
      "沒預設?",
      "挑一個",
    ]);
  });

  it("select 沒有選項是程式錯誤,不是靜默回 undefined", async () => {
    await expect(createAutoPrompter().select("空", [])).rejects.toThrow(/at least one option/);
  });
});
