import { describe, it, expect } from "vitest";
import { recordingExecutor, type ExecResult } from "./exec.js";
import {
  isPlaceholderId,
  parseCreatedD1Id,
  PLACEHOLDER_ID,
  WranglerClient,
} from "./wrangler.js";

const UUID = "11111111-2222-3333-4444-555555555555";

function makeClient(
  responses: (cmd: string, args: readonly string[]) => ExecResult | undefined,
  dryRun = false,
) {
  const { executor, calls } = recordingExecutor(responses);
  const client = new WranglerClient({
    exec: executor,
    cwd: "/repo",
    cmd: "wrangler",
    prefix: [],
    dryRun,
  });
  return { client, calls };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: "", stderr });

describe("parseCreatedD1Id", () => {
  it("優先認 wrangler 印出來的設定片段", () => {
    expect(
      parseCreatedD1Id(`✅ Successfully created DB 'cms-db'

{
  "d1_databases": [
    { "binding": "DB", "database_name": "cms-db", "database_id": "${UUID}" }
  ]
}`),
    ).toBe(UUID);
  });

  it("格式變了也還撿得到 UUID", () => {
    expect(parseCreatedD1Id(`created database ${UUID} in WNAM`)).toBe(UUID);
  });

  it("完全撈不到就回 null(不能瞎猜)", () => {
    expect(parseCreatedD1Id("Successfully created DB 'cms-db'")).toBeNull();
    expect(parseCreatedD1Id("")).toBeNull();
  });
});

describe("isPlaceholderId", () => {
  it("認得佔位值、空字串與缺值", () => {
    expect(isPlaceholderId(PLACEHOLDER_ID)).toBe(true);
    expect(isPlaceholderId("")).toBe(true);
    expect(isPlaceholderId(undefined)).toBe(true);
    expect(isPlaceholderId(UUID)).toBe(false);
  });
});

describe("WranglerClient — 唯讀操作", () => {
  it("whoami 成功時取得 email", async () => {
    const { client, calls } = makeClient(() => ok(`{"email":"a@b.c"}`));
    await expect(client.whoami()).resolves.toEqual({
      authenticated: true,
      detail: "a@b.c",
    });
    expect(calls[0].args).toEqual(["whoami", "--json"]);
  });

  it("whoami 失敗 = 未登入,並把 wrangler 的訊息帶回來", async () => {
    const { client } = makeClient(() => fail("Not logged in"));
    await expect(client.whoami()).resolves.toEqual({
      authenticated: false,
      detail: "Not logged in",
    });
  });

  it("listD1 解析 JSON 陣列", async () => {
    const { client } = makeClient(() =>
      ok(JSON.stringify([{ name: "cms-db", uuid: UUID }, { bad: 1 }])),
    );
    await expect(client.listD1()).resolves.toEqual({
      dbs: [{ name: "cms-db", uuid: UUID }],
      detail: null,
    });
  });

  it("listD1 失敗或非 JSON 回 dbs:null —— 呼叫端不可當成空清單", async () => {
    for (const make of [
      () => fail("boom"),
      () => ok("not json"),
      () => ok(`{"x":1}`),
    ]) {
      const res = await makeClient(make).client.listD1();
      expect(res.dbs).toBeNull();
      // 失敗一定要帶回可讀的原因,否則呼叫端只能印一句沒有指向性的話。
      expect(res.detail).toBeTruthy();
    }
  });

  it("listD1 失敗時把 wrangler 的原始訊息帶回來", async () => {
    const res = await makeClient(() =>
      fail("More than one account available but unable to select one"),
    ).client.listD1();
    expect(res.detail).toContain("More than one account available");
  });

  it("accountAmbiguityHint 只在多帳號時給指引", () => {
    expect(WranglerClient.accountAmbiguityHint(null)).toBeNull();
    expect(WranglerClient.accountAmbiguityHint("network unreachable")).toBeNull();
    const hint = WranglerClient.accountAmbiguityHint(
      "✘ More than one account available but unable to select one in non-interactive mode.",
    );
    expect(hint?.join("\n")).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("r2Exists:0 = 存在,not found = 不存在,其他錯誤 = 不知道", async () => {
    await expect(makeClient(() => ok("info")).client.r2Exists("b")).resolves.toBe(true);
    await expect(
      makeClient(() => fail("The specified bucket does not exist")).client.r2Exists("b"),
    ).resolves.toBe(false);
    await expect(
      makeClient(() => fail("Authentication error")).client.r2Exists("b"),
    ).resolves.toBeNull();
  });

  it("listSecrets 取名字;查不到回 null(Worker 可能還沒 deploy)", async () => {
    await expect(
      makeClient(() => ok(`[{"name":"SECRETS_KEY","type":"secret_text"}]`)).client.listSecrets(),
    ).resolves.toEqual(["SECRETS_KEY"]);
    await expect(
      makeClient(() => fail("workers.api.error.script_not_found")).client.listSecrets(),
    ).resolves.toBeNull();
  });

  it("唯讀操作在 dry-run 下照樣執行(不然計畫是編的)", async () => {
    const { client, calls } = makeClient(() => ok("[]"), true);
    await client.listD1();
    await client.r2Exists("b");
    expect(calls.length).toBe(2);
  });
});

describe("WranglerClient — 寫入操作", () => {
  it("createD1 成功時回傳 uuid", async () => {
    const { client, calls } = makeClient(() => ok(`"database_id": "${UUID}"`));
    const res = await client.createD1("cms-db");
    expect(res.outcome).toEqual({ status: "done" });
    expect(res.uuid).toBe(UUID);
    expect(calls[0].args).toEqual(["d1", "create", "cms-db"]);
  });

  it("createD1 成功但讀不到 id → 失敗,而且訊息要說「資源可能已建立」", async () => {
    const { client } = makeClient(() => ok("created, no id here"));
    const res = await client.createD1("cms-db");
    expect(res.uuid).toBeNull();
    expect(res.outcome.status).toBe("failed");
    expect(
      res.outcome.status === "failed" ? res.outcome.detail : "",
    ).toMatch(/已建立 D1「cms-db」/);
  });

  it("createR2 把 already exists 視為成功(冪等)", async () => {
    const { client } = makeClient(() => fail("A bucket with this name already exists"));
    await expect(client.createR2("cms-storage")).resolves.toEqual({ status: "done" });
  });

  it("createR2 其他錯誤才算失敗", async () => {
    const { client } = makeClient(() => fail("Authentication error"));
    const outcome = await client.createR2("cms-storage");
    expect(outcome.status).toBe("failed");
  });

  it("putSecret 的值走 stdin,不會出現在 argv", async () => {
    const { client, calls } = makeClient(() => ok(""));
    await client.putSecret("SECRETS_KEY", "s3cr3t-value");
    expect(calls[0].args).toEqual(["secret", "put", "SECRETS_KEY"]);
    expect(calls[0].args.join(" ")).not.toContain("s3cr3t-value");
    expect(calls[0].hadStdin).toBe(true);
  });

  it("applyMigrations 用的就是 db:migrate:remote 那條指令", async () => {
    const { client, calls } = makeClient(() => ok(""));
    await client.applyMigrations("cms-db");
    expect(calls[0].args).toEqual([
      "d1",
      "migrations",
      "apply",
      "cms-db",
      "--remote",
    ]);
  });

  it("dry-run 下所有寫入操作一次都不送出", async () => {
    const { client, calls } = makeClient(() => ok(""), true);
    expect((await client.createD1("cms-db")).outcome).toEqual({ status: "planned" });
    expect(await client.createR2("b")).toEqual({ status: "planned" });
    expect(await client.putSecret("K", "v")).toEqual({ status: "planned" });
    expect(await client.applyMigrations("cms-db")).toEqual({ status: "planned" });
    expect(calls).toEqual([]);
  });

  it("指定 configPath 時每條指令都帶 --config", async () => {
    const { executor, calls } = recordingExecutor(() => ok("[]"));
    const client = new WranglerClient({
      exec: executor,
      cwd: "/repo",
      cmd: "wrangler",
      prefix: ["wrangler"],
      dryRun: false,
      configPath: "/repo/wrangler.jsonc",
    });
    await client.listD1();
    expect(calls[0].args).toEqual([
      "wrangler",
      "d1",
      "list",
      "--json",
      "--config",
      "/repo/wrangler.jsonc",
    ]);
  });
});
