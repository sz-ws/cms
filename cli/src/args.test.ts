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

  it("parses `setup` 與它的旗標", () => {
    const a = parseArgs([
      "setup",
      "--config",
      "custom.jsonc",
      "--site-slug",
      "acme-taipei",
      "--dry-run",
      "--yes",
      "--skip-migrations",
      "--skip-secrets",
    ]);
    expect(a.command).toBe("setup");
    expect(a.config).toBe("custom.jsonc");
    expect(a.siteSlug).toBe("acme-taipei");
    expect(a.dryRun).toBe(true);
    expect(a.yes).toBe(true);
    expect(a.skipMigrations).toBe(true);
    expect(a.skipSecrets).toBe(true);
  });

  it("setup 旗標預設全關", () => {
    const a = parseArgs(["setup"]);
    expect(a.config).toBeUndefined();
    expect(a.yes).toBe(false);
    expect(a.allowSharedDefaultNames).toBe(false);
    expect(a.skipMigrations).toBe(false);
    expect(a.skipSecrets).toBe(false);
  });

  it("parses `preflight` 與 --gate", () => {
    const a = parseArgs(["preflight", "--gate", "--config", "w.jsonc"]);
    expect(a.command).toBe("preflight");
    expect(a.gate).toBe(true);
    expect(a.config).toBe("w.jsonc");
  });

  it("--gate 預設關閉(不給就是唯讀列出,不擋 deploy)", () => {
    expect(parseArgs(["preflight"]).gate).toBe(false);
    expect(parseArgs(["add", "blog"]).gate).toBe(false);
  });

  it("-y 是 --yes 的簡寫", () => {
    expect(parseArgs(["setup", "-y"]).yes).toBe(true);
  });

  it("--config=value 形式", () => {
    expect(parseArgs(["setup", "--config=a/b.jsonc"]).config).toBe("a/b.jsonc");
  });

  it("解析 site slug 與明確共用名稱逃生門", () => {
    const a = parseArgs(["setup", "--site-slug=acme", "--allow-shared-default-names"]);
    expect(a.siteSlug).toBe("acme");
    expect(a.allowSharedDefaultNames).toBe(true);
  });

  it("--config 缺值時報錯", () => {
    expect(parseArgs(["setup", "--config"]).error).toContain("--config");
  });

  it("add 的旗標語意沒有被 setup 影響(既有契約不破)", () => {
    const a = parseArgs(["add", "cron", "--force"]);
    expect(a.command).toBe("add");
    expect(a.id).toBe("cron");
    expect(a.force).toBe(true);
    expect(a.yes).toBe(false);
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
