import { describe, expect, it } from "vitest";
import { FLAGS_WITH_VALUE } from "../args.js";
import { COMMANDS, findCommand } from "./commands.js";
import { CliError } from "./errors.js";
import { helpJson, renderCommandHelp, renderGlobalHelp } from "./help.js";
import { parseCommand, resolveCommand } from "./parse.js";
import { AGENT_NOTE, ERROR_CODES, EXIT_CODE_MEANINGS, FLAG_ALIASES, GLOBAL_FLAGS } from "./spec.js";
import { editDistance, nearest } from "./suggest.js";

function parseError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliError) return e;
    throw e;
  }
  throw new Error("expected a CliError");
}

describe("suggest", () => {
  it("measures edit distance", () => {
    expect(editDistance("status", "statsu")).toBe(1);
    expect(editDistance("status", "sttaus")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });
  it("suggests a close command and nothing for a far one", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(nearest("stauts", names)).toBe("status");
    expect(nearest("docter", names)).toBe("doctor");
    expect(nearest("frobnicate", names)).toBeUndefined();
  });
  it("treats a unique prefix as a match", () => {
    expect(nearest("doc", ["doctor", "deploy"])).toBe("doctor");
  });
});

describe("resolveCommand", () => {
  it("finds the command after global flags", () => {
    const r = resolveCommand(["-C", "site", "--json", "status"]);
    expect(r).toMatchObject({ kind: "command", spec: { name: "status" }, rest: ["-C", "site", "--json"] });
  });
  it("matches two-word commands first", () => {
    const r = resolveCommand(["version", "list", "--limit", "3"]);
    expect(r).toMatchObject({ kind: "command", spec: { name: "version list" }, rest: ["--limit", "3"] });
  });
  it("suggests within a command group", () => {
    expect(resolveCommand(["version", "lsit"])).toMatchObject({ kind: "unknown", input: "version lsit", suggestion: "version list" });
    expect(resolveCommand(["version", "zzz"])).toMatchObject({ kind: "unknown", suggestion: "version list" });
  });
  it("reports none when only flags are given", () => {
    expect(resolveCommand(["--json"])).toEqual({ kind: "none" });
  });
  it("does not read past a bare --", () => {
    expect(resolveCommand(["--", "status"])).toEqual({ kind: "none" });
  });
});

describe("parseCommand", () => {
  const status = findCommand("status")!;
  const versions = findCommand("version list")!;
  const logs = findCommand("logs")!;

  it("fills defaults and env, and remembers what was explicit", () => {
    const p = parseCommand(status, ["--json"], { CLOUDFLARE_ACCOUNT_ID: "from-env" });
    expect(p.values).toMatchObject({ json: true, config: "wrangler.jsonc", account: "from-env", help: false });
    expect([...p.explicit]).toEqual(["json"]);
  });
  it("lets the flag win over the env", () => {
    const p = parseCommand(status, ["--account", "flag"], { CLOUDFLARE_ACCOUNT_ID: "env" });
    expect(p.values.account).toBe("flag");
    expect(p.explicit.has("account")).toBe(true);
  });
  it("coerces numbers and rejects non-numbers", () => {
    expect(parseCommand(versions, ["--limit", "3"], {}).values.limit).toBe(3);
    expect(parseError(() => parseCommand(versions, ["--limit", "x"], {})).code).toBe("BAD_VALUE");
  });
  it("rejects an unknown flag with a suggestion, exit 2", () => {
    const e = parseError(() => parseCommand(status, ["--jsno"], {}));
    expect(e).toMatchObject({ code: "UNKNOWN_FLAG", exit: 2 });
    expect(e.hint).toContain("--json");
  });
  it("rejects a value flag without a value instead of eating the next flag", () => {
    expect(parseError(() => parseCommand(status, ["--dir", "--json"], {})).code).toBe("BAD_VALUE");
    expect(parseError(() => parseCommand(status, ["--dir"], {})).code).toBe("BAD_VALUE");
  });
  it("rejects stray positionals", () => {
    expect(parseError(() => parseCommand(status, ["extra"], {})).code).toBe("BAD_VALUE");
  });
  it("collects everything after -- as passthrough", () => {
    const p = parseCommand(logs, ["--json", "--", "--status", "error"], {});
    expect(p.passthrough).toEqual(["--status", "error"]);
    expect(p.values.json).toBe(true);
  });
});

describe("command table", () => {
  it("lists every command once, including the 0.x ones", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of ["init", "deploy", "plugin add", "create", "setup", "secrets", "preflight", "add", "status", "doctor", "login", "version list", "logs", "help"]) {
      expect(names).toContain(name);
    }
  });
  it("accepts every value flag the 0.x parser knew, as a flag or an alias", () => {
    const tableFlags = new Set([
      ...COMMANDS.flatMap((c) => c.flags.map((f) => `--${f.name}`)),
      ...GLOBAL_FLAGS.map((f) => `--${f.name}`),
      ...Object.keys(FLAG_ALIASES).map((f) => `--${f}`),
    ]);
    for (const flag of FLAGS_WITH_VALUE) expect(tableFlags).toContain(flag);
  });
  it("only names error codes that exist", () => {
    const known = new Set(ERROR_CODES.map((e) => e.code));
    for (const c of COMMANDS) for (const code of c.errorCodes) expect(known).toContain(code);
  });
  it("only names exit codes that exist, for table commands", () => {
    const known = new Set(EXIT_CODE_MEANINGS.map((e) => e.code as number));
    for (const c of COMMANDS.filter((x) => x.parser === "table")) for (const code of c.exitCodes) expect(known).toContain(code);
  });
});

describe("help", () => {
  it("starts with the agent note and lists every command without dumping flags", () => {
    const text = renderGlobalHelp("9.9.9");
    expect(text.split("\n")[2]).toBe(AGENT_NOTE);
    for (const c of COMMANDS) expect(text).toContain(`cms ${c.name}`);
    expect(text).not.toContain("--skip-core-check");
  });
  it("renders a command with flags, examples and exit codes", () => {
    const text = renderCommandHelp(findCommand("version list")!);
    expect(text).toContain("cms version list [flags]");
    expect(text).toContain("--limit <n>");
    expect(text).toContain("default 10");
    expect(text).toContain("Exit codes");
    expect(text).toContain("cms version list --limit 3 --json");
  });
  it("renders the plugin installer with its own exit numbering", () => {
    const text = renderCommandHelp(findCommand("plugin add")!);
    expect(text).toContain("--skip-core-check");
    expect(text).toContain("0.x numbering");
  });
  it("gives the whole table as data", () => {
    const data = helpJson("9.9.9");
    expect(data.commands.map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    const status = data.commands.find((c) => c.name === "status")!;
    expect(status).toMatchObject({ mutates: "none", output: "envelope" });
    expect(data.globalFlags.find((f) => f.name === "--account")).toMatchObject({ env: "CLOUDFLARE_ACCOUNT_ID" });
    const add = data.commands.find((c) => c.name === "add")!;
    expect(add.flags.find((f) => f.name === "--token")).toMatchObject({ secret: true, env: "SZWS_REGISTRY_TOKEN" });
  });
});
