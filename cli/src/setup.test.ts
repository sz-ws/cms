import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordingExecutor, type ExecResult, type RecordedCall } from "./exec.js";
import { PLACEHOLDER_ID, WranglerClient } from "./wrangler.js";
import {
  runSetup,
  SECRETS_KEY,
  AUTH_PEPPER,
  SETUP_TOKEN,
  type SetupOptions,
} from "./setup.js";
import { createReporter, makeStyles, type Prompter } from "./ui.js";
import { EXIT } from "./exit.js";

const DB_UUID = "11111111-2222-3333-4444-555555555555";
const TAG_UUID = "66666666-7777-8888-9999-aaaaaaaaaaaa";

const CONFIG = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  // main 指向 custom-worker.ts —— 這一行絕對不能被 setup 動到。
  "main": "custom-worker.ts",
  "name": "cms",
  "triggers": { "crons": ["* * * * *"] },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "cms" }],
  // 新 clone 尚未選定租戶。
  "vars": { "CMS_SITE_SLUG": "" },
  "d1_databases": [
    // 第一個佔位值
    { "binding": "DB", "database_name": "cms-db", "database_id": "${PLACEHOLDER_ID}", "migrations_dir": "migrations" },
    // 第二個佔位值 —— DEPLOY.md 說最容易漏掉這個
    { "binding": "NEXT_TAG_CACHE_D1", "database_name": "cms-tag-cache", "database_id": "${PLACEHOLDER_ID}" }
  ],
  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "cms-storage" },
    { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "cms-next-cache" }
  ]
}
`;

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

/** 依 wrangler 子指令回應的假帳號。預設:已登入、帳號全空、Worker 還沒 deploy。 */
interface FakeAccount {
  authenticated?: boolean;
  d1?: { name: string; uuid: string }[] | "error";
  r2Existing?: string[];
  secrets?: string[] | "error";
  createdD1Uuid?: string;
  failOn?: (args: readonly string[]) => ExecResult | undefined;
}

function fakeWrangler(account: FakeAccount = {}) {
  return recordingExecutor((_cmd, args) => {
    const override = account.failOn?.(args);
    if (override) return override;
    const key = args.join(" ");
    if (key.startsWith("whoami")) {
      return account.authenticated === false
        ? fail("Not logged in")
        : ok(`{"email":"dev@example.com"}`);
    }
    if (key.startsWith("d1 list")) {
      if (account.d1 === "error") return fail("network");
      return ok(JSON.stringify(account.d1 ?? []));
    }
    if (key.startsWith("d1 create")) {
      const uuid = account.createdD1Uuid ?? DB_UUID;
      return ok(`{ "database_id": "${uuid}" }`);
    }
    if (key.startsWith("r2 bucket info")) {
      const name = args[3];
      return (account.r2Existing ?? []).includes(name)
        ? ok("info")
        : fail("The specified bucket does not exist");
    }
    if (key.startsWith("r2 bucket create")) return ok("");
    if (key.startsWith("secret list")) {
      if (account.secrets === undefined || account.secrets === "error") {
        return fail("workers.api.error.script_not_found");
      }
      return ok(JSON.stringify(account.secrets.map((name) => ({ name }))));
    }
    if (key.startsWith("secret put")) return ok("");
    if (key.startsWith("d1 migrations apply")) return ok("applied");
    return ok("");
  });
}

/** 腳本化的 Prompter:依序回答,答完之後一律用預設值。 */
function scriptedPrompter(
  answers: boolean[],
  textAnswers: string[] = [],
  selectAnswers: number[] = [],
): Prompter & { asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  let textIndex = 0;
  let selectIndex = 0;
  return {
    asked,
    async confirm(question, defaultValue) {
      asked.push(question);
      return i < answers.length ? answers[i++] : defaultValue;
    },
    async text(question, d) {
      asked.push(question);
      return textIndex < textAnswers.length ? textAnswers[textIndex++] : (d ?? "");
    },
    async select(question, options) {
      // 問題也要記進 asked —— 「有沒有真的問過使用者」是可被斷言的行為,
      // 不記的話「代選」與「問過才選」在測試裡長得一模一樣。
      asked.push(question);
      const pick = selectIndex < selectAnswers.length ? selectAnswers[selectIndex++] : 0;
      return options[pick].value;
    },
    // setup 自己不問 secret(它的三把金鑰是自動產生的),但介面要求要有這個方法。
    async secret() {
      throw new Error("setup should never prompt for a secret value");
    },
  };
}

let repo: string;
let configPath: string;
let output: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "szws-setup-"));
  configPath = path.join(repo, "wrangler.jsonc");
  await writeFile(configPath, CONFIG, "utf8");
  output = "";
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

interface HarnessOverrides extends Partial<SetupOptions> {
  /** select 題目的答案(索引);不給則一律挑第一個。 */
  selectAnswers?: number[];
  account?: FakeAccount;
  answers?: boolean[];
  textAnswers?: string[];
}

async function setup(overrides: HarnessOverrides = {}): Promise<{
  code: number;
  calls: RecordedCall[];
  out: string;
  prompter: ReturnType<typeof scriptedPrompter>;
}> {
  const { executor, calls } = fakeWrangler(overrides.account);
  const prompter = scriptedPrompter(
    overrides.answers ?? [],
    overrides.textAnswers,
    overrides.selectAnswers,
  );
  const code = await runSetup({
    cwd: repo,
    configPath,
    client: new WranglerClient({
      exec: executor,
      cwd: repo,
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
    prompter,
    dryRun: false,
    interactive: false,
    assumeYes: true,
    skipMigrations: false,
    skipSecrets: false,
    // 舊流程測試刻意在單站假帳號跑;新租戶邊界案例會明確關掉這個逃生門。
    allowSharedDefaultNames: true,
    generateSecret: () => "deterministic-test-key",
    ...overrides,
  });
  return { code, calls, out: output, prompter };
}

const argsOf = (calls: RecordedCall[]) => calls.map((c) => c.args.join(" "));

describe("runSetup — 全新帳號的完整流程", () => {
  it("建兩組 D1、兩組 R2、回填 id、套 migrations、設 secret", async () => {
    const { code, calls } = await setup({
      account: { createdD1Uuid: DB_UUID, secrets: [] },
    });
    expect(code).toBe(EXIT.OK);

    const sent = argsOf(calls);
    expect(sent).toContain("d1 create cms-db");
    expect(sent).toContain("d1 create cms-tag-cache");
    expect(sent).toContain("r2 bucket create cms-storage");
    expect(sent).toContain("r2 bucket create cms-next-cache");
    expect(sent).toContain(`secret put ${SECRETS_KEY}`);
    // pepper 必須跟 SECRETS_KEY 一樣是全新站台的預設產物 —— 漏掉它,第一批
    // 密碼就會以無 pepper 的形式落地,事後只能靠逐一重設密碼補回來。
    expect(sent).toContain(`secret put ${AUTH_PEPPER}`);
    expect(sent).toContain(`secret put ${SETUP_TOKEN}`);

    // migrations 只對宣告了 migrations_dir 的 cms-db 跑。
    expect(sent).toContain("d1 migrations apply cms-db --remote");
    expect(sent).not.toContain("d1 migrations apply cms-tag-cache --remote");

    const written = await readFile(configPath, "utf8");
    expect(written).not.toContain(PLACEHOLDER_ID);
    expect(written).toContain(`"database_id": "${DB_UUID}"`);
    // 別人維護的欄位原封不動。
    expect(written).toContain(`"main": "custom-worker.ts"`);
    expect(written).toContain(`"triggers": { "crons": ["* * * * *"] }`);
    expect(written).toContain("// main 指向 custom-worker.ts");
    expect(written).toContain("// 第二個佔位值");
  });

  it("secret 的值走 stdin,不進 argv", async () => {
    const { calls } = await setup({ account: { secrets: [] } });
    const put = calls.find((c) => c.args.join(" ").startsWith("secret put"));
    expect(put?.hadStdin).toBe(true);
    expect(calls.some((c) => c.args.includes("deterministic-test-key"))).toBe(false);
  });

  it("收尾一定講得出下一步", async () => {
    const { out } = await setup({ account: { secrets: [] } });
    expect(out).toContain("pnpm run deploy");
    expect(out).toContain("/setup");
    expect(out).toContain("core.siteUrl");
  });
});

// 收尾曾經是一坨扁平的行(next steps + 延後的金鑰 + 三段警告全塞進 outro),
// 結果是使用者掃不到那三段「做錯會鎖死整站」的警告。這一組守的是分區與內容。
describe("runSetup — 收尾輸出的結構", () => {
  const NOTE_TITLES = [
    "next steps",
    "⚠ before you create the first admin",
    "⚠ these keys can never be rotated",
  ];

  it("分成有標題的區塊,「接下來做什麼」與「危險警告」是分開的", async () => {
    const { out } = await setup({ account: { secrets: [] } });
    for (const title of NOTE_TITLES) expect(out).toContain(title);
    // 順序:先做什麼,再警告什麼。倒過來的話警告會被下一步沖走。
    expect(out.indexOf("next steps")).toBeLessThan(
      out.indexOf("⚠ before you create the first admin"),
    );
    expect(out.indexOf("⚠ before you create the first admin")).toBeLessThan(
      out.indexOf("⚠ these keys can never be rotated"),
    );
  });

  // 這三段每一句都是「照做才不會把整站鎖死」的資訊。刪字等於刪掉那個保護。
  it("三段警告一個字都沒少", async () => {
    const { out } = await setup({ account: { secrets: [] } });
    for (const line of [
      `⚠ ${AUTH_PEPPER} must be set **before** opening /setup to create first admin,`,
      "otherwise first batch of passwords will lack pepper protection (can still login, but less secure).",
      `⚠ if ${SETUP_TOKEN} is not set, /setup always returns 503 — this is intentional:`,
      "without it, first person to find the URL becomes admin.",
      "⚠ don't reuse dev keys from .dev.vars. both cannot be rotated once set:",
      `rotate ${SECRETS_KEY} → all encrypted settings become gibberish (envelope has no key id).`,
      `rotate ${AUTH_PEPPER} → all existing passwords become uncomputable, site completely locked.`,
    ]) {
      expect(out).toContain(line);
    }
  });

  // `cms secrets` + postdeploy 之後,「deploy 完再跑一次 setup」這個往返不存在了。
  // 留著那句話會讓人做一次完全白工的重跑。
  it("不再叫使用者回頭重跑 setup 補金鑰", async () => {
    const { out } = await setup({ account: { secrets: "error" } });
    expect(out).not.toContain("rerun setup now to complete");
    expect(out).toContain("postdeploy");
  });

  // openssl 那三行是備援,不是主要路徑 —— 它必須排在「跑 deploy 就會自動補」之後。
  it("手動 openssl 指令降級成備援,排在自動路徑後面", async () => {
    const { out } = await setup({ account: { secrets: "error" } });
    const auto = out.indexOf("will be set right after the first deploy");
    const fallback = out.indexOf("fallback — only if that automatic step fails");
    expect(auto).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThan(auto);
    expect(out.indexOf("openssl rand -base64 32")).toBeGreaterThan(fallback);
  });
});

describe("runSetup — site slug 租戶邊界", () => {
  it("新的 scaffold 在非互動模式沒有 slug 就拒絕,不查也不建帳號資源", async () => {
    const { code, calls, out } = await setup({ allowSharedDefaultNames: false });
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(calls).toHaveLength(0);
    expect(out).toContain("site slug required");
    expect(out).toContain("--allow-shared-default-names");
  });

  it("互動模式會要求 slug,並拒絕不符合 Cloudflare 安全交集的字元", async () => {
    const { code, calls, prompter, out } = await setup({
      allowSharedDefaultNames: false,
      assumeYes: false,
      textAnswers: ["Acme_Taipei"],
    });
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(calls).toHaveLength(0);
    expect(prompter.asked[0]).toContain("site slug");
    expect(out).toContain("lowercase alphanumeric/hyphen");
  });

  it("設定過的 site 重跑不再問 slug、不改名也不重建", async () => {
    const first = await setup({
      allowSharedDefaultNames: false,
      siteSlug: "client-a",
      account: { secrets: [SECRETS_KEY] },
    });
    expect(first.code).toBe(EXIT.OK);
    const afterFirst = await readFile(configPath, "utf8");

    const second = await setup({
      allowSharedDefaultNames: false,
      account: {
        d1: [
          { name: "cms-client-a-db", uuid: DB_UUID },
          { name: "cms-client-a-tag-cache", uuid: DB_UUID },
        ],
        r2Existing: ["cms-client-a-storage", "cms-client-a-next-cache"],
        secrets: [SECRETS_KEY],
      },
    });
    expect(second.code).toBe(EXIT.OK);
    expect(second.prompter.asked).toHaveLength(0);
    expect(await readFile(configPath, "utf8")).toBe(afterFirst);
    expect(argsOf(second.calls).some((s) => s.startsWith("d1 create"))).toBe(false);
    expect(argsOf(second.calls).some((s) => s.startsWith("r2 bucket create"))).toBe(false);
  });

  it("預設 cms 名稱在未明示單站模式時拒絕", async () => {
    const { code, out } = await setup({ allowSharedDefaultNames: false });
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out).toContain("shared default names");
  });

  it("新的 clone 撞到同 slug 的 D1 時拒絕認領,且不改設定檔", async () => {
    const before = await readFile(configPath, "utf8");
    const { code, calls, out } = await setup({
      allowSharedDefaultNames: false,
      siteSlug: "client-a",
      account: { d1: [{ name: "cms-client-a-db", uuid: DB_UUID }] },
    });
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out).toContain("will not claim existing D1");
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(argsOf(calls).some((s) => s.startsWith("d1 create"))).toBe(false);
  });

  it("slug 的單次 JSONC 編輯會更新五個名稱與 self-reference,保留註解", async () => {
    const { code } = await setup({
      allowSharedDefaultNames: false,
      siteSlug: "acme-taipei",
      skipMigrations: true,
      skipSecrets: true,
    });
    expect(code).toBe(EXIT.OK);
    const written = await readFile(configPath, "utf8");
    expect(written).toContain('"name": "cms-acme-taipei"');
    expect(written).toContain('"service": "cms-acme-taipei"');
    // 預設合併:兩個 d1 binding 都指向 <base>-db,所以 tag-cache 這個名字不該出現。
    expect(written).toContain('"database_name": "cms-acme-taipei-db"');
    expect(written).not.toContain("cms-acme-taipei-tag-cache");
    expect(written).toContain('"bucket_name": "cms-acme-taipei-storage"');
    expect(written).toContain('"bucket_name": "cms-acme-taipei-next-cache"');
    expect(written).toContain('"CMS_SITE_SLUG": "acme-taipei"');
    expect(written).toContain("// main 指向 custom-worker.ts");
    expect(written).toContain("// 第一個佔位值");
    expect(written).toContain("// 新 clone 尚未選定租戶。");
  });
});

describe("runSetup — 冪等 / 可重跑", () => {
  it("資源都在時不重建,設定檔也不再改動", async () => {
    const account: FakeAccount = {
      d1: [
        { name: "cms-db", uuid: DB_UUID },
        { name: "cms-tag-cache", uuid: TAG_UUID },
      ],
      r2Existing: ["cms-storage", "cms-next-cache"],
      secrets: [SECRETS_KEY, AUTH_PEPPER, SETUP_TOKEN],
    };
    const first = await setup({ account });
    expect(first.code).toBe(EXIT.OK);
    const afterFirst = await readFile(configPath, "utf8");

    const second = await setup({ account });
    expect(second.code).toBe(EXIT.OK);
    expect(await readFile(configPath, "utf8")).toBe(afterFirst);

    const sent = argsOf(second.calls);
    expect(sent.some((s) => s.startsWith("d1 create"))).toBe(false);
    expect(sent.some((s) => s.startsWith("r2 bucket create"))).toBe(false);
    expect(sent.some((s) => s.startsWith("secret put"))).toBe(false);
  });

  it("跑到一半斷掉:第二次重跑會沿用既有資源而不是再建一份", async () => {
    // 第一次:只有 cms-db 建成功,tag cache 掛掉。
    const firstRun = await setup({
      account: {
        d1: [],
        failOn: (args) =>
          args.join(" ") === "d1 create cms-tag-cache" ? fail("rate limited") : undefined,
      },
    });
    expect(firstRun.code).toBe(EXIT.SETUP_FAILED);
    // 已經拿到的 id 仍然寫了回去 —— 否則使用者會以為什麼都沒成功。
    const mid = await readFile(configPath, "utf8");
    expect(mid).toContain(`"database_id": "${DB_UUID}"`);
    expect(mid).toContain(PLACEHOLDER_ID); // tag cache 還是佔位值

    // 第二次:帳號上已經有 cms-db 了,只該補 tag cache。
    output = "";
    const secondRun = await setup({
      account: {
        d1: [{ name: "cms-db", uuid: DB_UUID }],
        createdD1Uuid: TAG_UUID,
      },
    });
    expect(secondRun.code).toBe(EXIT.OK);
    const sent = argsOf(secondRun.calls);
    expect(sent).not.toContain("d1 create cms-db");
    expect(sent).toContain("d1 create cms-tag-cache");
    const final = await readFile(configPath, "utf8");
    expect(final).not.toContain(PLACEHOLDER_ID);
    expect(final).toContain(`"database_id": "${TAG_UUID}"`);
  });

  it("設定檔 id 與帳號實際 uuid 不一致時,以帳號為準改寫", async () => {
    await writeFile(
      configPath,
      CONFIG.replace(PLACEHOLDER_ID, "99999999-9999-9999-9999-999999999999"),
      "utf8",
    );
    const { code } = await setup({
      account: {
        d1: [{ name: "cms-db", uuid: DB_UUID }],
        createdD1Uuid: TAG_UUID,
      },
    });
    expect(code).toBe(EXIT.OK);
    const written = await readFile(configPath, "utf8");
    expect(written).toContain(`"database_id": "${DB_UUID}"`);
    expect(written).not.toContain("99999999-9999-9999-9999-999999999999");
  });

  // SETUP_TOKEN 是三把裡唯一必須讓人看到的:wrangler 事後讀不回 secret 的值,
  // 不印就等於沒有人建得出第一個管理員。這條壞掉的方式是靜默的,所以要守。
  it("SETUP_TOKEN 產生後一定把值印出來,另外兩把一定不印", async () => {
    const secret = "TEST-SECRET-VALUE-DO-NOT-REUSE";
    const { out } = await setup({
      account: { secrets: [] },
      generateSecret: () => secret,
    });
    expect(out).toContain(SETUP_TOKEN);
    expect(out).toContain(secret);
    // 值只能出現一次 —— 三把用的是同一個假產生器,若 SECRETS_KEY / AUTH_PEPPER
    // 也被印出來,這裡就會看到三次。
    expect(out.split(secret).length - 1).toBe(1);
  });

  it("已存在的 secret 絕不覆寫", async () => {
    const { calls, out } = await setup({
      account: { secrets: [SECRETS_KEY, AUTH_PEPPER, SETUP_TOKEN] },
    });
    expect(argsOf(calls).some((s) => s.startsWith("secret put"))).toBe(false);
    expect(out).toContain("Not overwriting");
  });

  // 兩把是分開判斷的:已經有 SECRETS_KEY 的既有站台,重跑 setup 應該只補
  // AUTH_PEPPER,而不是連帶把 SECRETS_KEY 也重設(那會讓既存的加密設定全毀)。
  it("既有站台重跑:只補上缺的那幾把,不動 SECRETS_KEY", async () => {
    const { calls } = await setup({ account: { secrets: [SECRETS_KEY] } });
    const puts = argsOf(calls).filter((s) => s.startsWith("secret put"));
    expect(puts).toEqual([`secret put ${AUTH_PEPPER}`, `secret put ${SETUP_TOKEN}`]);
  });
});

describe("runSetup — dry-run", () => {
  it("什麼都不建、不改檔,但偵測指令照跑", async () => {
    const before = await readFile(configPath, "utf8");
    const { code, calls, out } = await setup({ dryRun: true });
    expect(code).toBe(EXIT.OK);
    expect(await readFile(configPath, "utf8")).toBe(before);

    const sent = argsOf(calls);
    // 唯讀偵測有跑(不跑的話印出來的計畫是編的)。
    expect(sent).toContain("d1 list --json");
    expect(sent.some((s) => s.startsWith("r2 bucket info"))).toBe(true);
    // 寫入類一次都沒送出。
    expect(sent.some((s) => s.startsWith("d1 create"))).toBe(false);
    expect(sent.some((s) => s.startsWith("r2 bucket create"))).toBe(false);
    expect(sent.some((s) => s.startsWith("secret put"))).toBe(false);
    expect(sent.some((s) => s.startsWith("d1 migrations"))).toBe(false);

    expect(out).toContain("create D1: 2");
    expect(out).toContain("create R2: 2");
    expect(out).toContain("nothing changed");
  });
});

describe("runSetup — 前置條件與中止", () => {
  it("未登入 → exit 7,並告訴你要跑 wrangler login", async () => {
    const { code, calls, out } = await setup({ account: { authenticated: false } });
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out).toContain("wrangler login");
    expect(argsOf(calls).some((s) => s.startsWith("d1 create"))).toBe(false);
  });

  it("讀不到 D1 清單 → exit 7,不硬做(會建出重複資料庫)", async () => {
    const { code, calls, out } = await setup({ account: { d1: "error" } });
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out).toContain("duplicate databases");
    expect(argsOf(calls).some((s) => s.startsWith("d1 create"))).toBe(false);
  });

  it("設定檔不存在 → exit 7", async () => {
    await rm(configPath);
    const { code, out } = await setup();
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out).toContain("CMS repo root");
  });

  it("設定檔格式壞掉 → exit 7,訊息帶位移", async () => {
    await writeFile(configPath, `{ "d1_databases": [ `, "utf8");
    const { code, out } = await setup();
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out).toContain("failed to parse");
  });

  it("使用者在確認關卡說不 → exit 9,零副作用", async () => {
    const before = await readFile(configPath, "utf8");
    const { code, calls, out } = await setup({ assumeYes: false, answers: [false] });
    expect(code).toBe(EXIT.SETUP_ABORTED);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(argsOf(calls).some((s) => s.startsWith("d1 create"))).toBe(false);
    expect(out).toContain("--dry-run");
  });

  it("互動模式會先問過才動手", async () => {
    const { code, prompter } = await setup({
      assumeYes: false,
      answers: [true, true],
      account: { secrets: [] },
    });
    expect(code).toBe(EXIT.OK);
    expect(prompter.asked[0]).toMatch(/create 2 D1 databases, 2 R2 buckets/);
  });
});

describe("runSetup — 失敗時仍給得出下一步", () => {
  it("migrations 失敗 → exit 8,並印出可單獨重跑的指令", async () => {
    const { code, out } = await setup({
      account: {
        secrets: [],
        failOn: (args) =>
          args[1] === "migrations" ? fail("no such table") : undefined,
      },
    });
    expect(code).toBe(EXIT.SETUP_FAILED);
    expect(out).toContain("wrangler d1 migrations apply cms-db --remote");
  });

  it("R2 建立失敗 → exit 8,並說明重跑會略過已建好的", async () => {
    const { code, out } = await setup({
      account: {
        failOn: (args) =>
          args.join(" ").startsWith("r2 bucket create") ? fail("Authentication error") : undefined,
      },
    });
    expect(code).toBe(EXIT.SETUP_FAILED);
    expect(out).toContain("rerun");
  });

  it("設定檔唯讀寫不進去 → exit 8,並把 id 印出來讓人手動填", async () => {
    await chmod(configPath, 0o444);
    try {
      const { code, out } = await setup();
      expect(code).toBe(EXIT.SETUP_FAILED);
      expect(out).toContain("manually fill in these database_ids");
      expect(out).toContain(DB_UUID);
    } finally {
      await chmod(configPath, 0o644);
    }
  });

  it("Worker 還沒 deploy(查不到 secret 清單)→ 不假裝設好,改講正確順序", async () => {
    const { code, calls, out } = await setup({ account: { secrets: "error" } });
    expect(code).toBe(EXIT.OK);
    expect(argsOf(calls).some((s) => s.startsWith("secret put"))).toBe(false);
    expect(out).toContain("worker may not be deployed yet");
    expect(out).toContain(`wrangler secret put ${SECRETS_KEY}`);
  });
});

describe("runSetup — 略過旗標", () => {
  it("--skip-migrations 不跑 migrations", async () => {
    const { calls, out } = await setup({ skipMigrations: true, account: { secrets: [] } });
    expect(argsOf(calls).some((s) => s.startsWith("d1 migrations"))).toBe(false);
    expect(out).toContain("--skip-migrations");
  });

  it("--skip-secrets 不碰 secret,但收尾要提醒", async () => {
    const { calls, out } = await setup({ skipSecrets: true });
    expect(argsOf(calls).some((s) => s.startsWith("secret"))).toBe(false);
    expect(out).toContain(`wrangler secret put ${SECRETS_KEY}`);
  });
});

// ---- 多帳號:互動時代選,非互動時絕不代選 ------------------------------------
const AMBIGUITY = `✘ [ERROR] More than one account available but unable to select one in non-interactive mode.
  Available accounts are (\`<name>\`: \`<account_id>\`):
    \`Personal\`: \`0f1e2d3c4b5a69788796a5b4c3d2e1f0\`
    \`專案\`: \`fedcba9876543210fedcba9876543210\`
`;

describe("runSetup — 登入多個 Cloudflare 帳號", () => {
  const savedEnv = process.env.CLOUDFLARE_ACCOUNT_ID;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = savedEnv;
  });

  it("非互動時絕不代選 —— 停下來並給指引", async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    let listCalls = 0;

    const { code, out } = await setup({
      interactive: false,
      account: {
        failOn: (args) => {
          if (args.join(" ").startsWith("d1 list")) {
            listCalls++;
            return { code: 1, stdout: "", stderr: AMBIGUITY };
          }
          return undefined;
        },
      },
    });

    // 這是本測試存在的理由:非互動的 prompter.select 會回「第一個選項」,
    // 拿它去挑 Cloudflare 帳號就是在別人的帳號上建資源。寧可停下來。
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    expect(listCalls).toBe(1); // 沒有重試
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("互動時問使用者、設進環境變數,然後重試一次", async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    let listCalls = 0;

    const { code, prompter } = await setup({
      interactive: true,
      // 選單一律挑第二個(專案),確認我們用的是使用者的選擇而不是第一筆。
      selectAnswers: [1],
      account: {
        createdD1Uuid: DB_UUID,
        secrets: [],
        failOn: (args) => {
          if (args.join(" ").startsWith("d1 list")) {
            listCalls++;
            // 第一次撞多帳號,設好之後第二次成功。
            if (listCalls === 1) return { code: 1, stdout: "", stderr: AMBIGUITY };
          }
          return undefined;
        },
      },
    });

    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe("fedcba9876543210fedcba9876543210");
    expect(listCalls).toBe(2); // 重試過
    expect(code).toBe(EXIT.OK);
    expect(prompter.asked.some((q) => /which Cloudflare account/i.test(q))).toBe(true);
  });
});

describe("runSetup — tag cache 的 D1 共用 / 獨立", () => {
  // Free plan 每帳號只有 10 個 D1。一個站吃 2 個的話只放得下 5 個站,
  // 合併之後是 10 個。這兩條把兩種模式都釘住。
  it("預設共用一個 D1 —— 只建一次,兩個 binding 拿到同一個 id", async () => {
    const { code, calls } = await setup({
      allowSharedDefaultNames: false,
      siteSlug: "acme",
      skipMigrations: true,
      skipSecrets: true,
      account: { createdD1Uuid: DB_UUID },
    });
    expect(code).toBe(EXIT.OK);

    const creates = argsOf(calls).filter((a) => a.startsWith("d1 create"));
    expect(creates).toEqual(["d1 create cms-acme-db"]); // 只有一次

    const written = await readFile(configPath, "utf8");
    // 兩個 d1_databases 項的 database_id 必須是同一個。
    const ids = [...written.matchAll(/"database_id":\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(DB_UUID);
  });

  it("--separate-tag-cache 回到兩個 D1", async () => {
    const { code, calls } = await setup({
      allowSharedDefaultNames: false,
      separateTagCache: true,
      siteSlug: "acme",
      skipMigrations: true,
      skipSecrets: true,
      account: { createdD1Uuid: DB_UUID },
    });
    expect(code).toBe(EXIT.OK);

    expect(argsOf(calls).filter((a) => a.startsWith("d1 create"))).toEqual([
      "d1 create cms-acme-db",
      "d1 create cms-acme-tag-cache",
    ]);
  });
});

describe("runSetup — 合併模式的計畫顯示", () => {
  // 回歸測試:合併之後 DB 與 NEXT_TAG_CACHE_D1 指向同一個資料庫,先前逐個 plan 印
  // 會變成「同一個名字出現兩次、各自說 needs to be created」,而確認句還說
  // 「create 2 D1 databases」—— 然後只建一個。數字與行數都要說實話。
  it("同一個資料庫只列一行,binding 併列,且說 1 個不是 2 個", async () => {
    const { code, out, prompter } = await setup({
      // 確認句是丟給 prompter 的,assumeYes 會整個跳過它 —— 要驗那句話就得真的問。
      assumeYes: false,
      answers: [true],
      allowSharedDefaultNames: false,
      siteSlug: "banana",
      skipMigrations: true,
      skipSecrets: true,
      account: { createdD1Uuid: DB_UUID },
    });
    expect(code).toBe(EXIT.OK);

    expect(out).toContain("D1 cms-banana-db (DB, NEXT_TAG_CACHE_D1) needs to be created");
    // 舊的逐行輸出不該再出現。
    expect(out).not.toContain("D1 cms-banana-db (DB) needs to be created");
    const confirm = prompter.asked.join("\n");
    expect(confirm).toContain("create 1 D1 database, 2 R2 buckets");
    expect(confirm).not.toContain("create 2 D1 databases");
  });

  it("--separate-tag-cache 照實說 2 個", async () => {
    const { code, out, prompter } = await setup({
      assumeYes: false,
      answers: [true],
      allowSharedDefaultNames: false,
      separateTagCache: true,
      siteSlug: "banana",
      skipMigrations: true,
      skipSecrets: true,
      account: { createdD1Uuid: DB_UUID },
    });
    expect(code).toBe(EXIT.OK);
    expect(prompter.asked.join("\n")).toContain("create 2 D1 databases");
    expect(out).toContain("D1 cms-banana-db (DB) needs to be created");
    expect(out).toContain("D1 cms-banana-tag-cache (NEXT_TAG_CACHE_D1) needs to be created");
  });
});
