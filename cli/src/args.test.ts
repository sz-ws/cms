import { describe, it, expect } from "vitest";
import { parseArgs, ID_RE } from "./args.js";

describe("parseArgs", () => {
  it("parses `add <id>`", () => {
    const a = parseArgs(["add", "newebpay"]);
    expect(a.command).toBe("add");
    expect(a.id).toBe("newebpay");
    expect(a.dryRun).toBe(false);
    expect(a.force).toBe(false);
    expect(a.error).toBeUndefined();
  });

  it("parses flags", () => {
    const a = parseArgs([
      "add",
      "cron",
      "--source",
      "https://example.com/reg",
      "--token",
      "abc123",
      "--dry-run",
      "--force",
      "--non-interactive",
      "--skip-core-check",
    ]);
    expect(a.source).toBe("https://example.com/reg");
    expect(a.token).toBe("abc123");
    expect(a.dryRun).toBe(true);
    expect(a.force).toBe(true);
    expect(a.nonInteractive).toBe(true);
    expect(a.skipCoreCheck).toBe(true);
  });

  it("--skip-core-check 預設關閉", () => {
    expect(parseArgs(["add", "cron"]).skipCoreCheck).toBe(false);
  });

  it("supports --flag=value form", () => {
    const a = parseArgs(["add", "cron", "--source=file:///tmp/reg"]);
    expect(a.source).toBe("file:///tmp/reg");
  });

  it("errors on missing flag value", () => {
    const a = parseArgs(["add", "cron", "--source"]);
    expect(a.error).toContain("--source");
  });

  it("errors on unknown flag", () => {
    const a = parseArgs(["add", "cron", "--wat"]);
    expect(a.error).toContain("--wat");
  });

  it("handles --help / --version", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });
});

describe("ID_RE", () => {
  it("accepts valid ids", () => {
    for (const id of ["cron", "newebpay", "ai-smoke-test", "a1"]) {
      expect(ID_RE.test(id)).toBe(true);
    }
  });
  it("rejects invalid / traversal ids", () => {
    for (const id of ["../secret", "Cron", "1abc", "-x", "a", "with space", "a/b"]) {
      expect(ID_RE.test(id)).toBe(false);
    }
  });
});
