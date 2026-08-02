import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureExtension } from "./configure.js";
import { createReporter, makeStyles, type Prompter } from "./ui.js";

// wrangler.jsonc 的每個欄位上面都壓著中文註解 —— 那些就是這份設定檔的文件本體。
// 下面每個寫入測試都會回頭斷言它們還在。
const CONFIG = `{
  // [site] 這個檔預期逐站不同。
  "$schema": "node_modules/wrangler/config-schema.json",
  // main 指向 custom-worker.ts,絕對不能被動到。
  "main": "custom-worker.ts",
  "name": "cms",
  // setup 用此值確認命名已由 slug 衍生。
  "vars": { "CMS_SITE_SLUG": "acme" },
  "d1_databases": [],
  "r2_buckets": []
}
`;

const MANIFEST = {
  id: "demo",
  settings: [
    {
      key: "merchantId",
      label: { en: "Merchant ID", "zh-Hant": "商店代號" },
      description: "藍新商店代號(MS 開頭)。",
      type: "text",
      default: "",
      required: true,
    },
    {
      key: "hashKey",
      label: "Hash Key",
      type: "text",
      secret: true,
      required: true,
      default: "",
    },
    {
      key: "env",
      label: "環境",
      type: "select",
      default: "test",
      options: [
        { value: "test", label: "測試機" },
        { value: "core", label: "正式機" },
      ],
    },
    { key: "debug", label: "Debug", type: "boolean", default: false },
  ],
};

let repo: string;
let extensionsDir: string;
let configPath: string;
let devVarsPath: string;
let output: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "szws-configure-"));
  extensionsDir = path.join(repo, "extensions");
  configPath = path.join(repo, "wrangler.jsonc");
  devVarsPath = path.join(repo, ".dev.vars");
  await mkdir(path.join(extensionsDir, "demo"), { recursive: true });
  await writeFile(configPath, CONFIG, "utf8");
  output = "";
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function writeManifest(manifest: unknown = MANIFEST): Promise<void> {
  await writeFile(
    path.join(extensionsDir, "demo", "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

interface Answers {
  text?: string[];
  secret?: string[];
  confirm?: boolean[];
  select?: number[];
}

/** 腳本化 Prompter。asked 記問題文字;secretsAsked 只記問題,**不記值**。 */
function scripted(answers: Answers): Prompter & { asked: string[] } {
  const asked: string[] = [];
  let t = 0;
  let s = 0;
  let c = 0;
  let sel = 0;
  return {
    asked,
    async text(question, d) {
      asked.push(question);
      return t < (answers.text?.length ?? 0) ? answers.text![t++] : (d ?? "");
    },
    async secret(question) {
      asked.push(question);
      return s < (answers.secret?.length ?? 0) ? answers.secret![s++] : "";
    },
    async confirm(question, d) {
      asked.push(question);
      return c < (answers.confirm?.length ?? 0) ? answers.confirm![c++] : d;
    },
    async select(question, options) {
      asked.push(question);
      const idx = sel < (answers.select?.length ?? 0) ? answers.select![sel++] : 0;
      return options[idx].value;
    },
  };
}

async function configure(answers: Answers, interactive = true) {
  const prompter = scripted(answers);
  const result = await configureExtension({
    extensionsDir,
    configPath,
    devVarsPath,
    extId: "demo",
    reporter: createReporter({
      write: (c) => {
        output += c;
      },
      animate: false,
      styles: makeStyles(false),
    }),
    prompter,
    interactive,
  });
  return { result, prompter, out: output };
}

describe("configureExtension", () => {
  it("沒有 manifest.json → 什麼都不做(code extension 不一定帶)", async () => {
    const { result } = await configure({});
    expect(result).toBeNull();
  });

  it("manifest 沒有 settings[] → 什麼都不做", async () => {
    await writeManifest({ id: "demo" });
    const { result } = await configure({});
    expect(result).toBeNull();
  });

  it("非 secret 的答案寫進 wrangler.jsonc 的 vars,型別照 setting type", async () => {
    await writeManifest();
    const { result } = await configure({
      text: ["MS123456"],
      secret: ["hash-secret"],
      select: [1],
      confirm: [true],
    });

    const written = await readFile(configPath, "utf8");
    expect(written).toContain('"EXT_DEMO_MERCHANT_ID": "MS123456"');
    expect(written).toContain('"EXT_DEMO_ENV": "core"');
    // boolean 要是 JSON 的 true,不是字串 "true"。
    expect(written).toContain('"EXT_DEMO_DEBUG": true');
    expect(result?.varsWritten).toEqual([
      "EXT_DEMO_MERCHANT_ID",
      "EXT_DEMO_ENV",
      "EXT_DEMO_DEBUG",
    ]);
  });

  // 🔴 這一條是本次改動的資安核心:cms 是公開 repo,wrangler.jsonc 會進版控。
  it("secret 的值絕不寫進 wrangler.jsonc —— 值與鍵都不出現", async () => {
    await writeManifest();
    await configure({
      text: ["MS123456"],
      secret: ["super-secret-value"],
      select: [0],
      confirm: [false],
    });

    const written = await readFile(configPath, "utf8");
    expect(written).not.toContain("super-secret-value");
    expect(written).not.toContain("EXT_DEMO_HASH_KEY");
    expect(written).not.toContain("hashKey");
  });

  it("secret 的值只落在 .dev.vars(已 gitignore),而且不出現在終端輸出", async () => {
    await writeManifest();
    const { out } = await configure({
      text: ["MS123456"],
      secret: ["super-secret-value"],
    });

    const devVars = await readFile(devVarsPath, "utf8");
    expect(devVars).toContain("EXT_DEMO_HASH_KEY=super-secret-value");
    expect((await stat(devVarsPath)).mode & 0o777).toBe(0o600);
    // reporter 只講鍵名,值一個字都不能印。
    expect(out).not.toContain("super-secret-value");
    expect(out).toContain("EXT_DEMO_HASH_KEY");
  });

  it("印出 `wrangler secret put`,但**不執行**任何 wrangler 指令", async () => {
    await writeManifest();
    const { result, out } = await configure({ text: ["MS1"], secret: ["v"] });
    expect(result?.secretCommands).toEqual([
      "  pnpm exec wrangler secret put EXT_DEMO_HASH_KEY",
    ]);
    expect(out).toContain("wrangler secret put EXT_DEMO_HASH_KEY");
    expect(out).toContain("this CLI will not run them for you");
    // configureExtension 根本沒有 WranglerClient 可用 —— 型別層就跑不了指令。
  });

  it("改完 wrangler.jsonc 後原有的中文註解仍在,排版沒有被重排", async () => {
    await writeManifest();
    await configure({ text: ["MS1"], secret: ["v"], select: [0], confirm: [true] });
    const written = await readFile(configPath, "utf8");
    expect(written).toContain("// [site] 這個檔預期逐站不同。");
    expect(written).toContain("// main 指向 custom-worker.ts,絕對不能被動到。");
    expect(written).toContain("// setup 用此值確認命名已由 slug 衍生。");
    expect(written).toContain('"main": "custom-worker.ts"');
    // 既有的 vars 成員原樣留著。
    expect(written).toContain('"CMS_SITE_SLUG": "acme"');
  });

  it("非必填留白就跳過,不會把空字串塞進 vars", async () => {
    await writeManifest({
      settings: [
        { key: "optional", label: "Optional", type: "text", default: "" },
      ],
    });
    const { result } = await configure({ text: [""] });
    expect(result?.varsWritten).toEqual([]);
    expect(await readFile(configPath, "utf8")).not.toContain("EXT_DEMO_OPTIONAL");
  });

  it("必填留白 → 記成 unanswered 並警告,不假裝成功", async () => {
    await writeManifest({
      settings: [
        { key: "needed", label: "Needed", type: "text", default: "", required: true },
      ],
    });
    const { result, out } = await configure({ text: [""] });
    expect(result?.unanswered).toEqual(["EXT_DEMO_NEEDED"]);
    expect(out).toContain("required settings left empty");
  });

  it("number 輸入不是數字 → 警告並跳過,不寫進 vars", async () => {
    await writeManifest({
      settings: [{ key: "port", label: "Port", type: "number", default: 0 }],
    });
    const { out } = await configure({ text: ["abc"] });
    expect(out).toContain("is not a number");
    expect(await readFile(configPath, "utf8")).not.toContain("EXT_DEMO_PORT");
  });

  it("非互動模式只列清單,一個問題都不問、一個字都不寫", async () => {
    await writeManifest();
    const { result, prompter, out } = await configure({}, false);
    expect(prompter.asked).toEqual([]);
    expect(result?.varsWritten).toEqual([]);
    expect(await readFile(configPath, "utf8")).toBe(CONFIG);
    await expect(stat(devVarsPath)).rejects.toThrow();
    expect(out).toContain("EXT_DEMO_HASH_KEY");
    expect(out).toContain(".dev.vars + wrangler secret put");
  });

  it("重跑同樣的答案 → 冪等,wrangler.jsonc 不再被寫", async () => {
    await writeManifest();
    await configure({ text: ["MS1"], secret: ["v"], select: [0], confirm: [false] });
    const first = await readFile(configPath, "utf8");
    const { result } = await configure({
      text: ["MS1"],
      secret: ["v"],
      select: [0],
      confirm: [false],
    });
    expect(result?.varsWritten).toEqual([]);
    expect(await readFile(configPath, "utf8")).toBe(first);
  });

  it("問題文字標示必填 / 可跳過,並在前一行帶出 description", async () => {
    await writeManifest();
    const { prompter, out } = await configure({ text: ["MS1"], secret: ["v"] });
    expect(prompter.asked[0]).toBe("Merchant ID (required)");
    expect(prompter.asked).toContain("環境 (optional, enter to skip)");
    expect(out).toContain("藍新商店代號(MS 開頭)。");
  });
});
