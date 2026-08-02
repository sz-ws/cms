import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordingExecutor, type ExecResult, type RecordedCall } from "./exec.js";
import { WranglerClient } from "./wrangler.js";
import { EXIT } from "./exit.js";
import { gateVerdict, judge, runPreflight, varIsSet } from "./preflight.js";
import { normalizeSetting, type SettingField } from "./settings.js";
import { createReporter, makeStyles } from "./ui.js";

const CONFIG = (vars: string) => `{
  // main 指向 custom-worker.ts,絕對不能被動到。
  "main": "custom-worker.ts",
  "name": "cms",
  // setup 用此值確認命名已由 slug 衍生。
  "vars": ${vars},
  "d1_databases": [],
  "r2_buckets": []
}
`;

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

let repo: string;
let extensionsDir: string;
let configPath: string;
let output: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "szws-preflight-"));
  extensionsDir = path.join(repo, "extensions");
  configPath = path.join(repo, "wrangler.jsonc");
  await mkdir(extensionsDir, { recursive: true });
  await writeFile(configPath, CONFIG('{ "CMS_SITE_SLUG": "acme" }'), "utf8");
  output = "";
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function writeManifest(extId: string, settings: unknown[]): Promise<void> {
  await mkdir(path.join(extensionsDir, extId), { recursive: true });
  await writeFile(
    path.join(extensionsDir, extId, "manifest.json"),
    JSON.stringify({ id: extId, settings }, null, 2),
    "utf8",
  );
}

/** 假 wrangler。`secrets: "error"` 模擬未登入 / Worker 尚未存在。 */
function fakeClient(secrets: string[] | "error" = []): {
  client: WranglerClient;
  calls: RecordedCall[];
} {
  const { executor, calls } = recordingExecutor((_cmd, args): ExecResult | undefined => {
    if (args.join(" ").startsWith("secret list")) {
      return secrets === "error"
        ? { code: 1, stdout: "", stderr: "You are not authenticated." }
        : {
            code: 0,
            stdout: JSON.stringify(secrets.map((name) => ({ name }))),
            stderr: "",
          };
    }
    return undefined;
  });
  return {
    client: new WranglerClient({
      exec: executor,
      cwd: "/nowhere",
      cmd: "wrangler",
      prefix: [],
      dryRun: false,
    }),
    calls,
  };
}

async function preflight(opts: {
  secrets?: string[] | "error";
  gate?: boolean;
}): Promise<{ code: number; out: string; calls: RecordedCall[] }> {
  const { client, calls } = fakeClient(opts.secrets ?? []);
  const code = await runPreflight({
    extensionsDir,
    configPath,
    client,
    reporter: createReporter({
      write: (c) => {
        output += c;
      },
      animate: false,
      styles: makeStyles(false),
    }),
    gate: opts.gate ?? false,
  });
  return { code, out: output, calls };
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
    expect(row.reason).toMatch(/could not query/);
  });
});

describe("gateVerdict", () => {
  it("有 missing → 非零", () => {
    const rows = [judge("d", field({ key: "a", required: true }), new Map(), [])];
    expect(gateVerdict(rows)).toBe(EXIT.PREFLIGHT_BLOCKED);
  });

  it("只有 unverifiable → 零(第一次 deploy 時 Worker 還不存在,擋了就永遠出不去)", () => {
    const rows = [
      judge("d", field({ key: "a", secret: true, required: true }), new Map(), null),
    ];
    expect(gateVerdict(rows)).toBe(EXIT.OK);
  });
});

describe("runPreflight", () => {
  it("沒有任何 manifest 宣告 settings → 明講「這支只看得到 manifest」", async () => {
    const { code, out } = await preflight({});
    expect(code).toBe(EXIT.OK);
    expect(out).toContain("no extension declares settings[]");
    expect(out).toContain("without a manifest.json are invisible to preflight");
  });

  it("輸出分成三區,不會讓「查不到」看起來像「已通過」", async () => {
    await writeFile(configPath, CONFIG('{ "EXT_DEMO_SET": "yes" }'), "utf8");
    await writeManifest("demo", [
      { key: "set", label: "Set", type: "text", default: "" },
      { key: "needed", label: "Needed", type: "text", default: "", required: true },
      { key: "optional", label: "Optional", type: "text", default: "" },
    ]);
    const { out } = await preflight({});
    expect(out).toContain("verified (1)");
    expect(out).toContain("missing — required (1)");
    expect(out).toContain("cannot be verified before deploy (1)");
    expect(out).toContain("D1 settings");
    expect(out).toContain("admin → Extensions → Settings");
  });

  it("--gate 缺必填 → 非零退出", async () => {
    await writeManifest("demo", [
      { key: "needed", label: "Needed", type: "text", default: "", required: true },
    ]);
    const { code, out } = await preflight({ gate: true });
    expect(code).toBe(EXIT.PREFLIGHT_BLOCKED);
    expect(out).toContain("deploy stopped");
    expect(out).toContain('"EXT_DEMO_NEEDED"');
  });

  it("--gate 齊全 → 零退出", async () => {
    await writeFile(configPath, CONFIG('{ "EXT_DEMO_NEEDED": "filled" }'), "utf8");
    await writeManifest("demo", [
      { key: "needed", label: "Needed", type: "text", default: "", required: true },
      { key: "secretOne", label: "Secret", type: "text", default: "", secret: true, required: true },
    ]);
    const { code, out } = await preflight({ gate: true, secrets: ["EXT_DEMO_SECRET_ONE"] });
    expect(code).toBe(EXIT.OK);
    expect(out).toContain("all declared settings are set");
  });

  // 🔴 未登入 CF 是常態(尤其是第一次 deploy 前)。降級,不崩潰。
  it("未登入 CF(secret list 失敗)→ 降級成「無法驗證」並繼續,不擋", async () => {
    await writeFile(configPath, CONFIG('{ "EXT_DEMO_NEEDED": "filled" }'), "utf8");
    await writeManifest("demo", [
      { key: "needed", label: "Needed", type: "text", default: "", required: true },
      { key: "apiKey", label: "API Key", type: "text", default: "", secret: true, required: true },
    ]);
    const { code, out } = await preflight({ gate: true, secrets: "error" });
    expect(code).toBe(EXIT.OK);
    expect(out).toContain("could not read the Worker secret list");
    expect(out).toContain("skipped, not passed");
    // 訊息要說清楚是「查不到」而不是「缺」。
    expect(out).toContain("required secrets could not be verified");
    expect(out).toContain("not blocking");
    expect(out).toContain("pnpm exec wrangler secret put EXT_DEMO_API_KEY");
    expect(out).not.toContain("deploy stopped");
  });

  it("沒有任何 secret 型設定時完全不打 `wrangler secret list`", async () => {
    await writeManifest("demo", [{ key: "plain", label: "Plain", type: "text", default: "" }]);
    const { calls } = await preflight({});
    expect(calls).toEqual([]);
  });

  it("讀不到 wrangler.jsonc 不會崩潰,只是所有 vars 項變成查不到", async () => {
    await rm(configPath);
    await writeManifest("demo", [
      { key: "needed", label: "Needed", type: "text", default: "", required: true },
    ]);
    const { code, out } = await preflight({ gate: true });
    expect(code).toBe(EXIT.PREFLIGHT_BLOCKED);
    expect(out).toContain("could not read wrangler.jsonc");
  });

  it("CJK 標籤下欄位仍然對齊(用欄寬,不是 String.length)", async () => {
    await writeFile(configPath, CONFIG('{ "EXT_DEMO_A": "x", "EXT_DEMO_B": "y" }'), "utf8");
    await writeManifest("demo", [
      { key: "a", label: "商店代號", type: "text", default: "" },
      { key: "b", label: "Merchant", type: "text", default: "" },
    ]);
    const { out } = await preflight({});
    const lines = out.split("\n").filter((l) => l.includes("EXT_DEMO_"));
    expect(lines).toHaveLength(2);
    // 兩行的 envKey 欄應該起始於同一欄。"商店代號" = 8 欄,"Merchant" = 8 欄,
    // 但 .length 分別是 4 與 8 —— 用 .length 對齊就會差 4 格。
    const columns = lines.map((l) => l.indexOf("EXT_DEMO_"));
    expect(columns[0]).not.toBe(columns[1]);
    const widths = lines.map((l) => l.slice(0, l.indexOf("EXT_DEMO_")));
    expect(widths[0].startsWith("  商店代號  ")).toBe(true);
    expect(widths[1].startsWith("  Merchant  ")).toBe(true);
  });

  it("多個 extension 一起掃,壞掉的 manifest 只警告不中斷", async () => {
    await mkdir(path.join(extensionsDir, "bad"), { recursive: true });
    await writeFile(path.join(extensionsDir, "bad", "manifest.json"), "nope", "utf8");
    await writeManifest("good", [
      { key: "needed", label: "Needed", type: "text", default: "", required: true },
    ]);
    const { code, out } = await preflight({ gate: true });
    expect(out).toContain("not valid JSON");
    expect(out).toContain("EXT_GOOD_NEEDED");
    expect(code).toBe(EXIT.PREFLIGHT_BLOCKED);
  });
});
