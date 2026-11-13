import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecResult, Executor } from "../exec.js";
import { CF_TESTED, compareVersions, findCf, installPlanFor, nodeTooOld } from "./cf-binary.js";
import { classify, failureFrom, firstJsonValue, parseFailure } from "./cf-output.js";
import { authSourceFrom, createCfPort, identityFrom } from "./cf-port.js";
import { CloudflareError } from "./port.js";
import { withRetry } from "./retry.js";

interface Call {
  cmd: string;
  args: string[];
  env?: Readonly<Record<string, string>>;
  inherit: boolean;
}

/** A scripted executor: answers by the joined args, records every call. */
function scripted(answers: Record<string, ExecResult | ExecResult[] | "ENOENT">): { exec: Executor; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Executor = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], env: opts.env, inherit: opts.inheritStdio === true });
    const key = [path.basename(cmd), ...args].join(" ");
    const answer = answers[key];
    if (answer === "ENOENT") throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
    if (Array.isArray(answer)) return answer.shift() ?? { code: 0, stdout: "", stderr: "" };
    return answer ?? { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const ok = (value: unknown, tail = ""): ExecResult => ({ code: 0, stdout: `${JSON.stringify(value, null, 2)}\n${tail}`, stderr: "" });
const apiError = (code: number, message: string, status: string): ExecResult => ({
  code: 1,
  stdout: "",
  stderr: `\n┌ APIError\n│ [${code}] ${message}\n│ ${status} · HTTP /accounts/abc123/workers/x\n└\n`,
});
const noSleep = async () => {};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cms-cf-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cf output", () => {
  it("takes the first JSON value and ignores advice printed after it", () => {
    expect(firstJsonValue(`{"a":"}{","b":[1]}\n→ Ask the user: {"x"}`)).toEqual({ a: "}{", b: [1] });
    expect(firstJsonValue("no json")).toBeUndefined();
  });
  it("reads the error box without the account path", () => {
    const f = parseFailure(apiError(10007, "This Worker does not exist on your account.", "404 Not Found").stderr, 1);
    expect(f).toEqual({ apiCode: 10007, status: 404, message: "This Worker does not exist on your account." });
    expect(failureFrom(apiError(10007, "gone", "404 Not Found").stderr, 1).message).not.toContain("abc123");
  });
  it("classifies failures", () => {
    expect(classify({ apiCode: 10007, message: "" })).toBe("NOT_FOUND");
    expect(classify({ status: 401, message: "" })).toBe("AUTH_INVALID");
    expect(classify({ apiCode: 10000, status: 403, message: "" })).toBe("AUTH_INVALID");
    expect(classify({ status: 403, message: "" })).toBe("PERMISSION_DENIED");
    expect(classify({ apiCode: 7403, status: 403, message: "" })).toBe("TRANSIENT");
    expect(classify({ status: 503, message: "" })).toBe("TRANSIENT");
    expect(classify({ status: 429, message: "" })).toBe("TRANSIENT");
    expect(classify({ message: "fetch failed: ECONNRESET" })).toBe("TRANSIENT");
    expect(classify({ message: "Not logged in" })).toBe("AUTH_REQUIRED");
    expect(classify({ apiCode: 7500, status: 400, message: "no such table" })).toBe("FAILED");
  });
});

describe("retry", () => {
  it("retries transient failures, then gives up with the last error", async () => {
    let n = 0;
    const slept: number[] = [];
    const fail = withRetry(async () => {
      n++;
      throw new CloudflareError("TRANSIENT", "busy");
    }, async (ms) => void slept.push(ms));
    await expect(fail).rejects.toThrow("busy");
    expect(n).toBe(3);
    expect(slept).toEqual([1000, 3000]);
  });
  it("does not retry other failures", async () => {
    let n = 0;
    await expect(withRetry(async () => {
      n++;
      throw new CloudflareError("FAILED", "bad");
    }, noSleep)).rejects.toThrow("bad");
    expect(n).toBe(1);
  });
});

describe("cf binary", () => {
  it("orders beta versions numerically", () => {
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.9")).toBe(1);
    expect(compareVersions("1.0.0-beta.32", "1.0.0-beta.32")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.40")).toBe(1);
    expect(compareVersions("1.0.0-beta.31", CF_TESTED)).toBe(-1);
  });
  it("knows the Node floor", () => {
    expect(nodeTooOld("v20.11.0")).toBe(true);
    expect(nodeTooOld("v22.12.0")).toBe(false);
  });
  it("prefers the site's own cf, then PATH", async () => {
    await mkdir(path.join(dir, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", ".bin", "cf"), "");
    const { exec, calls } = scripted({ "cf --version": { code: 0, stdout: `${CF_TESTED}\n`, stderr: "" } });
    const r = await findCf(exec, dir, "v22.12.0");
    expect(r).toMatchObject({ state: "ready", version: CF_TESTED, untested: false, command: path.join(dir, "node_modules", ".bin", "cf") });
    expect(calls).toHaveLength(1);
  });
  it("reports missing, too old, untested and node-too-old", async () => {
    expect(await findCf(scripted({ "cf --version": "ENOENT" }).exec, dir, "v22.0.0")).toEqual({ state: "missing" });
    expect(await findCf(scripted({ "cf --version": { code: 0, stdout: "1.0.0-beta.10", stderr: "" } }).exec, dir, "v22.0.0")).toMatchObject({ state: "unsupported" });
    expect(await findCf(scripted({ "cf --version": { code: 0, stdout: "1.0.0-beta.40", stderr: "" } }).exec, dir, "v22.0.0")).toMatchObject({ state: "ready", untested: true });
    expect(await findCf(scripted({}).exec, dir, "v20.0.0")).toEqual({ state: "node-too-old", node: "v20.0.0" });
  });
  it("installs with the project's package manager, pinned to the tested release", async () => {
    expect(installPlanFor(dir).display).toBe(`npm install -g cf@${CF_TESTED}`);
    await writeFile(path.join(dir, "package.json"), "{}");
    expect(installPlanFor(dir).display).toBe(`npm install --save-dev cf@${CF_TESTED}`);
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "");
    expect(installPlanFor(dir)).toEqual({ display: `pnpm add -D cf@${CF_TESTED}`, cmd: "pnpm", args: ["add", "-D", `cf@${CF_TESTED}`] });
  });
});

describe("cf port", () => {
  const version = { code: 0, stdout: CF_TESTED, stderr: "" };

  it("reads whoami into an identity without leaking cf's credential path", () => {
    expect(authSourceFrom("OAuth token from /home/someone/.config/cf/default.json", { name: "default" })).toEqual({ kind: "oauth", label: "signed in through cf" });
    expect(authSourceFrom("CLOUDFLARE_API_TOKEN environment variable", { name: "ci" })).toMatchObject({ kind: "api-token", profile: "ci" });
    expect(identityFrom({ authenticated: true, tokenValid: false })).toEqual({ authenticated: false, accounts: [] });
    expect(identityFrom({ authenticated: false, error: "Not logged in" }).authenticated).toBe(false);
  });

  it("sends the account in CLOUDFLARE_ACCOUNT_ID and parses each read", async () => {
    const { exec, calls } = scripted({
      "cf --version": version,
      "cf workers get cms-acme": ok({ name: "cms-acme", subdomain: { enabled: true, url: "https://cms-acme.example.workers.dev" } }),
      "cf workers deployments list --worker cms-acme --per-page 1": ok({ deployments: [{ id: "d1", created_on: "2026-11-01T00:00:00Z", versions: [{ version_id: "v1", percentage: 100 }] }] }),
      "cf workers versions list --worker cms-acme --per-page 5": ok([{ id: "v1", number: 3, created_on: "2026-11-01T00:00:00Z", source: "wrangler", annotations: { "workers/message": "hello" } }]),
      "cf d1 list --per-page 100": ok([{ uuid: "db1", name: "cms-acme-db" }]),
      "cf d1 migrations list db1 --dir migrations": ok([{ Name: "0002_b.sql" }]),
      "cf r2 buckets list --name-contains cms-acme-media": ok({ buckets: [{ name: "cms-acme-media-old" }, { name: "cms-acme-media" }] }),
      "cf kv namespaces list --per-page 100": ok([{ id: "k1", title: "cms-acme-kv" }]),
      "cf workers secrets list --worker cms-acme": ok([{ name: "SECRETS_KEY", type: "secret_text" }]),
    });
    const reads = createCfPort({ exec, cwd: dir, nodeVersion: "v22.12.0", sleep: noSleep }).account("acc1");
    expect(await reads.worker("cms-acme")).toMatchObject({ workersDevUrl: "https://cms-acme.example.workers.dev" });
    expect(await reads.deployments("cms-acme", 1)).toEqual([{ id: "d1", createdOn: "2026-11-01T00:00:00Z", versions: [{ versionId: "v1", percentage: 100 }] }]);
    expect(await reads.versions("cms-acme", 5)).toMatchObject([{ id: "v1", number: 3, message: "hello" }]);
    expect(await reads.d1List()).toEqual([{ id: "db1", name: "cms-acme-db" }]);
    expect(await reads.d1PendingMigrations("db1", "migrations")).toEqual(["0002_b.sql"]);
    expect(await reads.r2Exists("cms-acme-media")).toBe(true);
    expect(await reads.kvList()).toEqual([{ id: "k1", title: "cms-acme-kv" }]);
    expect(await reads.secretNames("cms-acme")).toEqual(["SECRETS_KEY"]);
    const reads_ = calls.filter((c) => c.args[0] !== "--version");
    expect(reads_.every((c) => c.env?.CLOUDFLARE_ACCOUNT_ID === "acc1" && c.env?.CF_QUIET === "1")).toBe(true);
    expect(calls.filter((c) => c.args[0] === "--version")).toHaveLength(1);
  });

  it("turns a missing Worker into null and other failures into errors", async () => {
    const { exec } = scripted({
      "cf --version": version,
      "cf workers get cms-none": apiError(10007, "This Worker does not exist on your account.", "404 Not Found"),
      "cf workers secrets list --worker cms-none": apiError(10007, "This Worker does not exist on your account.", "404 Not Found"),
      "cf d1 list --per-page 100": apiError(10000, "Authentication error", "403 Forbidden"),
    });
    const reads = createCfPort({ exec, cwd: dir, nodeVersion: "v22.12.0", sleep: noSleep }).account("acc1");
    expect(await reads.worker("cms-none")).toBeNull();
    expect(await reads.secretNames("cms-none")).toBeNull();
    await expect(reads.d1List()).rejects.toMatchObject({ failure: "AUTH_INVALID" });
  });

  it("retries a transient failure and then succeeds", async () => {
    const { exec, calls } = scripted({
      "cf --version": version,
      "cf kv namespaces list --per-page 100": [apiError(10013, "An unknown error has occurred", "500 Internal Server Error"), ok([])],
    });
    const reads = createCfPort({ exec, cwd: dir, nodeVersion: "v22.12.0", sleep: noSleep }).account("acc1");
    expect(await reads.kvList()).toEqual([]);
    expect(calls.filter((c) => c.args[0] === "kv")).toHaveLength(2);
  });

  it("treats a signed-out whoami as not authenticated", async () => {
    const { exec } = scripted({
      "cf --version": version,
      "cf auth whoami": ok({ authenticated: false, error: "Not logged in" }, "→ Ask the user: ..."),
    });
    const port = createCfPort({ exec, cwd: dir, nodeVersion: "v22.12.0", sleep: noSleep });
    expect(await port.whoami()).toEqual({ authenticated: false, accounts: [] });
  });

  it("hands the terminal to cf for login and to the package manager for install", async () => {
    await writeFile(path.join(dir, "package.json"), "{}");
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "");
    const { exec, calls } = scripted({ "cf --version": version });
    const port = createCfPort({ exec, cwd: dir, nodeVersion: "v22.12.0", sleep: noSleep });
    expect(await port.login()).toBe(true);
    expect(await port.install()).toBe(true);
    expect(calls.filter((c) => c.inherit).map((c) => [path.basename(c.cmd), ...c.args].join(" "))).toEqual([
      "cf auth login",
      `pnpm add -D cf@${CF_TESTED}`,
    ]);
  });

  it("writes: creates are sent once, secrets travel in a private file, never in argv", async () => {
    const seenBodies: string[] = [];
    const calls: Call[] = [];
    const exec: Executor = async (cmd, args, opts) => {
      calls.push({ cmd, args: [...args], env: opts.env, inherit: false });
      const body = args.find((a) => a.startsWith("@"));
      if (body) seenBodies.push(await import("node:fs/promises").then((fs) => fs.readFile(body.slice(1), "utf8")));
      if (args[0] === "--version") return version;
      if (args.join(" ") === "d1 create --name cms-acme-db") return ok({ uuid: "new-db", name: "cms-acme-db" });
      if (args[0] === "r2" && args[2] === "create") return apiError(10013, "busy", "500 Internal Server Error");
      return { code: 0, stdout: "", stderr: "" };
    };
    const api = createCfPort({ exec, cwd: dir, nodeVersion: "v22.12.0", sleep: noSleep }).account("acc1");
    expect(await api.d1Create("cms-acme-db")).toEqual({ id: "new-db", name: "cms-acme-db" });
    await expect(api.r2Create("cms-acme-storage")).rejects.toMatchObject({ failure: "TRANSIENT" });
    expect(calls.filter((c) => c.args[0] === "r2")).toHaveLength(1);
    await api.putSecret("cms-acme", "SECRETS_KEY", "s3cr3t-value");
    const put = calls.find((c) => c.args[1] === "secrets")!;
    expect(put.args.slice(0, 5)).toEqual(["workers", "secrets", "update", "SECRETS_KEY", "--worker"]);
    expect(put.args.join(" ")).not.toContain("s3cr3t-value");
    expect(JSON.parse(seenBodies[0])).toEqual({ name: "SECRETS_KEY", type: "secret_text", text: "s3cr3t-value" });
    expect(existsSync(put.args[put.args.length - 1].slice(1))).toBe(false);
    await api.r2SetLifecycleRules("cms-acme-next-cache", [{ id: "expire-page-cache", enabled: true }]);
    expect(calls[calls.length - 1].args).toEqual(expect.arrayContaining(["lifecycle", "update", "cms-acme-next-cache", "-f"]));
    await api.promote("cms-acme", "v9");
    expect(calls[calls.length - 1].args).toEqual(["workers", "deployments", "create", "--worker", "cms-acme", "--strategy", "percentage", "--versions", '[{"version_id":"v9","percentage":100}]']);
  });
});
