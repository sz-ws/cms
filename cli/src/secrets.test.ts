import { describe, it, expect, beforeEach } from "vitest";
import { recordingExecutor, type ExecResult, type RecordedCall } from "./exec.js";
import { WranglerClient } from "./wrangler.js";
import {
  runSecrets,
  SECRETS_KEY,
  AUTH_PEPPER,
  SETUP_TOKEN,
  MANAGED_SECRETS,
  manualSecretCommands,
  defaultSecretGenerator,
} from "./secrets.js";
import { createReporter, makeStyles } from "./ui.js";
import { EXIT } from "./exit.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

interface FakeAccount {
  /** 已設定的 secret 名稱;"error" = `secret list` 查不到(Worker 還沒 deploy)。 */
  secrets?: string[] | "error";
  failPut?: readonly string[];
}

function fakeWrangler(account: FakeAccount = {}) {
  return recordingExecutor((_cmd, args) => {
    const key = args.join(" ");
    if (key.startsWith("secret list")) {
      if (account.secrets === undefined || account.secrets === "error") {
        return fail("workers.api.error.script_not_found");
      }
      return ok(JSON.stringify(account.secrets.map((name) => ({ name }))));
    }
    if (key.startsWith("secret put")) {
      return (account.failPut ?? []).includes(args[2]) ? fail("Authentication error") : ok("");
    }
    return ok("");
  });
}

let output: string;
beforeEach(() => {
  output = "";
});

async function secrets(
  overrides: {
    account?: FakeAccount;
    dryRun?: boolean;
    generateSecret?: () => string;
  } = {},
): Promise<{ code: number; calls: RecordedCall[]; out: string }> {
  const { executor, calls } = fakeWrangler(overrides.account);
  const code = await runSecrets({
    client: new WranglerClient({
      exec: executor,
      cwd: "/nonexistent",
      cmd: "wrangler",
      prefix: [],
      dryRun: overrides.dryRun ?? false,
    }),
    reporter: createReporter({
      write: (c) => {
        output += c;
      },
      animate: false,
      styles: makeStyles(false),
    }),
    dryRun: overrides.dryRun ?? false,
    generateSecret: overrides.generateSecret ?? (() => "deterministic-test-key"),
  });
  return { code, calls, out: output };
}

const argsOf = (calls: RecordedCall[]) => calls.map((c) => c.args.join(" "));

describe("runSecrets — 全新部署的 Worker", () => {
  it("三把都不存在 → 三把都產生並送出", async () => {
    const { code, calls } = await secrets({ account: { secrets: [] } });
    expect(code).toBe(EXIT.OK);
    const sent = argsOf(calls);
    expect(sent).toContain(`secret put ${SECRETS_KEY}`);
    expect(sent).toContain(`secret put ${AUTH_PEPPER}`);
    expect(sent).toContain(`secret put ${SETUP_TOKEN}`);
  });

  it("值走 stdin,不進 argv", async () => {
    const { calls } = await secrets({ account: { secrets: [] } });
    const puts = calls.filter((c) => c.args.join(" ").startsWith("secret put"));
    expect(puts).toHaveLength(3);
    expect(puts.every((c) => c.hadStdin)).toBe(true);
    expect(calls.some((c) => c.args.includes("deterministic-test-key"))).toBe(false);
  });
});

// 覆寫任何一把都是不可逆的災難(SECRETS_KEY → 加密設定全毀、AUTH_PEPPER → 全站鎖死、
// SETUP_TOKEN → 還沒有管理員的站台把自己鎖在外面)。這是整支指令最重要的性質。
describe("runSecrets — 絕不覆寫既有金鑰", () => {
  it("三把都在 → 一次 put 都不送", async () => {
    const { code, calls, out } = await secrets({
      account: { secrets: [SECRETS_KEY, AUTH_PEPPER, SETUP_TOKEN] },
    });
    expect(code).toBe(EXIT.OK);
    expect(argsOf(calls).some((s) => s.startsWith("secret put"))).toBe(false);
    expect(out).toContain("Not overwriting");
    expect(out).toContain("already set");
  });

  it("只有部分存在 → 只補缺的那幾把,既有的完全不碰", async () => {
    const { code, calls } = await secrets({ account: { secrets: [SECRETS_KEY] } });
    expect(code).toBe(EXIT.OK);
    const puts = argsOf(calls).filter((s) => s.startsWith("secret put"));
    expect(puts).toEqual([`secret put ${AUTH_PEPPER}`, `secret put ${SETUP_TOKEN}`]);
  });

  it("重跑是冪等的:第二次什麼都不做", async () => {
    const first = await secrets({ account: { secrets: [] } });
    expect(first.code).toBe(EXIT.OK);
    const second = await secrets({
      account: { secrets: [SECRETS_KEY, AUTH_PEPPER, SETUP_TOKEN] },
    });
    expect(argsOf(second.calls).some((s) => s.startsWith("secret put"))).toBe(false);
  });
});

// wrangler 事後讀不回 secret 的值,所以 SETUP_TOKEN 不印 = 使用者永遠建不出第一個
// 管理員。另外兩把剛好相反:它們的值永遠不需要被人眼看到,印出來只有壞處
//(scrollback、螢幕分享、CI log)。
describe("runSecrets — 只有 SETUP_TOKEN 的值會出現在輸出裡", () => {
  it("新建時印出 SETUP_TOKEN 的值,而且只印一次", async () => {
    const value = "TEST-SECRET-VALUE-DO-NOT-REUSE";
    const { out } = await secrets({
      account: { secrets: [] },
      generateSecret: () => value,
    });
    expect(out).toContain(SETUP_TOKEN);
    expect(out).toContain(value);
    // 三把用同一個假產生器:若 SECRETS_KEY / AUTH_PEPPER 也被印,這裡會是 3。
    expect(out.split(value).length - 1).toBe(1);
  });

  it("SECRETS_KEY / AUTH_PEPPER 的值一個字元都不出現", async () => {
    // 每把給不同的值,才分得出「哪一把漏出去了」。
    const values = new Map([
      [SECRETS_KEY, "AAAA-secrets-key-value-AAAA"],
      [AUTH_PEPPER, "BBBB-auth-pepper-value-BBBB"],
      [SETUP_TOKEN, "CCCC-setup-token-value-CCCC"],
    ]);
    const order = MANAGED_SECRETS.map((s) => s.name);
    let i = 0;
    const { out } = await secrets({
      account: { secrets: [] },
      generateSecret: () => values.get(order[i++]) ?? "unexpected",
    });
    expect(out).not.toContain(values.get(SECRETS_KEY));
    expect(out).not.toContain(values.get(AUTH_PEPPER));
    expect(out).toContain(values.get(SETUP_TOKEN));
  });

  it("SETUP_TOKEN 已存在時不印任何值(既有的值我們也讀不到)", async () => {
    const value = "SHOULD-NEVER-APPEAR";
    const { out } = await secrets({
      account: { secrets: [SECRETS_KEY, AUTH_PEPPER, SETUP_TOKEN] },
      generateSecret: () => value,
    });
    expect(out).not.toContain(value);
  });
});

describe("runSecrets — Worker 還不存在 / 查不到清單", () => {
  it("查不到 secret list → 不硬寫,非零退出,並印出手動指令", async () => {
    const { code, calls, out } = await secrets({ account: { secrets: "error" } });
    expect(code).toBe(EXIT.SETUP_FAILED);
    // 查不到 ≠ 沒設定。硬寫下去可能覆寫掉別的 Worker 上真正在用的金鑰。
    expect(argsOf(calls).some((s) => s.startsWith("secret put"))).toBe(false);
    expect(out).toContain("could not read the Worker secret list");
    for (const line of manualSecretCommands()) expect(out).toContain(line);
    // 三段警告在這條路徑上也要在 —— 這正是最可能真的把站台鎖死的情境。
    expect(out).toContain("must be set **before** opening /setup");
    expect(out).toContain("always returns 503");
    expect(out).toContain("cannot be rotated once set");
  });

  it("某一把 put 失敗 → 非零退出,只針對那一把給手動指令", async () => {
    const { code, out } = await secrets({
      account: { secrets: [], failPut: [AUTH_PEPPER] },
    });
    expect(code).toBe(EXIT.SETUP_FAILED);
    expect(out).toContain(`wrangler secret put ${AUTH_PEPPER}`);
    // 成功的那兩把不該出現在「手動補救」清單裡。
    expect(out).not.toContain(`wrangler secret put ${SECRETS_KEY}`);
  });
});

describe("runSecrets — dry-run", () => {
  it("只報告,一次 put 都不送", async () => {
    const { code, calls, out } = await secrets({
      account: { secrets: [SECRETS_KEY] },
      dryRun: true,
    });
    expect(code).toBe(EXIT.OK);
    // 唯讀的 secret list 照跑(不跑的話報告是編的)。
    expect(argsOf(calls)).toContain("secret list --format json");
    expect(argsOf(calls).some((s) => s.startsWith("secret put"))).toBe(false);
    expect(out).toContain("would generate 2 missing secrets");
    expect(out).toContain("nothing was generated");
  });
});

describe("defaultSecretGenerator", () => {
  it("產生 32 byte 的 base64,每次都不同", () => {
    const a = defaultSecretGenerator();
    const b = defaultSecretGenerator();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64")).toHaveLength(32);
  });
});
