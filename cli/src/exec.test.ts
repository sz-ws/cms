import { afterEach, describe, expect, it } from "vitest";
import { childEnv, ProgramMissingError, spawnExecutor } from "./exec.js";

const ADDED = ["CMS_ADMIN_PASSWORD", "CMS_ADMIN_EMAIL", "CMS_SETUP_TOKEN", "CMS_SITE_SLUG"];

afterEach(() => {
  for (const key of ADDED) delete process.env[key];
});

describe("childEnv", () => {
  // 密碼與 setup token 只有 CLI 這個行程用得到。原封不動繼承下去的話,
  // `pnpm install` 的每一個 lifecycle script、build、wrangler 全都讀得到明文。
  it("濾掉管理員憑證與 setup token,其餘照舊", () => {
    const keys = Object.keys(childEnv({
      PATH: "/usr/bin",
      CMS_ADMIN_EMAIL: "owner@example.com",
      CMS_ADMIN_PASSWORD: "private-test-password",
      CMS_SETUP_TOKEN: "private-test-token",
      CMS_SITE_SLUG: "demo",
    }));
    expect(keys).toEqual(["PATH", "CMS_SITE_SLUG"]);
  });
});

describe("spawnExecutor", () => {
  it("真的 spawn 出來的子程序看不到憑證", async () => {
    process.env.CMS_ADMIN_EMAIL = "owner@example.com";
    process.env.CMS_ADMIN_PASSWORD = "private-test-password";
    process.env.CMS_SETUP_TOKEN = "private-test-token";
    process.env.CMS_SITE_SLUG = "demo";
    const result = await spawnExecutor(
      process.execPath,
      ["-e", 'console.log(JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith("CMS_"))))'],
      { cwd: process.cwd() },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["CMS_SITE_SLUG"]);
  });

  // 繼承終端的代價就是讀不到輸出;呼叫端只能靠 exit code,這條把那個契約釘住。
  it("inheritStdio 下只回 exit code,不回輸出", async () => {
    const result = await spawnExecutor(
      process.execPath,
      ["-e", "process.exit(3)"],
      { cwd: process.cwd(), inheritStdio: true },
    );
    expect(result).toEqual({ code: 3, stdout: "", stderr: "" });
  });
});

describe("spawnExecutor — 程式不存在", () => {
  // 只在這一層把 ENOENT 換成帶名字的錯誤;上層再翻成有下一步的 CliError。
  it("回 ProgramMissingError,不是原始的 spawn … ENOENT", async () => {
    const error = await spawnExecutor("/nonexistent/bin/pnpm", ["install"], { cwd: process.cwd() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProgramMissingError);
    expect(error).toMatchObject({ program: "pnpm" });
  });
});
