// wrangler 操作的型別化包裝。所有指令都走注入進來的 Executor,所以測試不需要
// (也絕不會)碰到真的 Cloudflare 帳號。
//
// 讀 / 寫分得很開,理由是 `--dry-run`:
//   - 讀(whoami / d1 list / r2 bucket info / secret list)在 dry-run 下**照跑**。
//     不跑就偵測不出「哪些已經存在」,dry-run 印出來的計畫會是編的。
//   - 寫(d1 create / r2 bucket create / secret put / migrations apply)在 dry-run 下
//     只回報「將要做什麼」,一次都不送出。

import type { Executor, ExecResult } from "./exec.js";

export const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function isPlaceholderId(id: string | undefined): boolean {
  return id === undefined || id.trim() === "" || id === PLACEHOLDER_ID;
}

/**
 * 從 `wrangler d1 create` 的輸出裡撈 database_id。
 * wrangler 會印一段可直接貼進設定檔的 JSON 片段,優先認 `"database_id": "…"`;
 * 認不到就退回「輸出裡第一個看起來像 UUID 的東西」。兩者皆無 → null(呼叫端要報錯,
 * 不能假裝成功 —— 資源可能真的建起來了,只是我們讀不到 id)。
 */
export function parseCreatedD1Id(output: string): string | null {
  const keyed = /"database_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(output);
  if (keyed) return keyed[1];
  const loose = UUID_RE.exec(output);
  return loose ? loose[0] : null;
}

export interface D1Database {
  name: string;
  uuid: string;
}

export interface WranglerClientOptions {
  exec: Executor;
  cwd: string;
  /** wrangler 可執行檔與前置參數(見 exec.ts:resolveWranglerCommand)。 */
  cmd: string;
  prefix: readonly string[];
  /** true → 寫入類指令只回報不執行。 */
  dryRun: boolean;
  /** 覆寫設定檔路徑(`--config`);未給則用 cwd 下的預設。 */
  configPath?: string;
}

/** 寫入類操作的結果:planned 表示因 dry-run 而未真的送出。 */
export type MutationOutcome =
  | { status: "done" }
  | { status: "planned" }
  | { status: "failed"; detail: string };

export class WranglerClient {
  private readonly o: WranglerClientOptions;

  constructor(options: WranglerClientOptions) {
    this.o = options;
  }

  private async run(args: readonly string[], stdin?: string): Promise<ExecResult> {
    const full = [...this.o.prefix, ...args];
    const withConfig = this.o.configPath
      ? [...full, "--config", this.o.configPath]
      : full;
    return this.o.exec(this.o.cmd, withConfig, { cwd: this.o.cwd, stdin });
  }

  /** dry-run 下也會執行(唯讀)。 */
  async whoami(): Promise<{ authenticated: boolean; detail: string }> {
    const r = await this.run(["whoami", "--json"]);
    if (r.code !== 0) {
      return { authenticated: false, detail: (r.stderr || r.stdout).trim() };
    }
    let email = "";
    try {
      const parsed = JSON.parse(r.stdout) as { email?: unknown };
      if (typeof parsed.email === "string") email = parsed.email;
    } catch {
      // whoami --json 理論上一定是 JSON;真不是也只影響顯示,不影響判定。
    }
    return { authenticated: true, detail: email };
  }

  /**
   * 帳號裡現有的 D1 清單。`dbs` 為 null 代表查不到(未登入 / 指令失敗),
   * 呼叫端不可當成「空的」。
   *
   * `detail` 帶回 wrangler 自己的訊息:失敗原因幾乎都只有它知道,最常見的是
   * 「登入了多個帳號、非互動模式無法選一個」—— 那則訊息直接寫了解法
   * (設定 CLOUDFLARE_ACCOUNT_ID)。把它吞掉會讓使用者完全找不到方向。
   */
  async listD1(): Promise<{ dbs: D1Database[] | null; detail: string | null }> {
    const r = await this.run(["d1", "list", "--json"]);
    if (r.code !== 0) {
      return { dbs: null, detail: (r.stderr || r.stdout).trim() || null };
    }
    try {
      const parsed = JSON.parse(r.stdout) as unknown;
      if (!Array.isArray(parsed)) {
        return { dbs: null, detail: "wrangler returned non-array JSON." };
      }
      const out: D1Database[] = [];
      for (const raw of parsed as { name?: unknown; uuid?: unknown }[]) {
        if (typeof raw?.name === "string" && typeof raw.uuid === "string") {
          out.push({ name: raw.name, uuid: raw.uuid });
        }
      }
      return { dbs: out, detail: null };
    } catch {
      return { dbs: null, detail: "wrangler output is not valid JSON." };
    }
  }

  /**
   * 多帳號是接案者/工作室的常態,而 wrangler 只在非互動模式才報這個錯 ——
   * 也就是 CI 與本 CLI。單獨挑出來給明確指引,不要只丟原始訊息。
   */

  /**
   * 從 wrangler 的多帳號錯誤裡把帳號清單解析出來。它的格式是每行
   *   `<name>`: `<account_id>`
   * 而 account_id 恆為 32 位小寫 hex。名稱可能含空白、`@`、中文(實測有
   * 「專案」「billing@example.org's Account」),所以名稱那段一律非貪婪抓到
   * 反引號為止,不要試圖用字元集去框。
   *
   * 解析失敗回空陣列而不是 throw —— 拿不到清單只是退回「印訊息請他自己設」,
   * 不該讓整個 setup 因為訊息格式變了而崩掉。
   */
  static parseAvailableAccounts(
    detail: string | null,
  ): { name: string; id: string }[] {
    if (!detail) return [];
    const out: { name: string; id: string }[] = [];
    const re = /`([^`]+)`\s*:\s*`([0-9a-f]{32})`/g;
    for (const m of detail.matchAll(re)) {
      out.push({ name: m[1], id: m[2] });
    }
    return out;
  }

  /** 這次失敗是不是「登入了多個帳號」。 */
  static isAccountAmbiguity(detail: string | null): boolean {
    return !!detail && /More than one account/i.test(detail);
  }

  static accountAmbiguityHint(detail: string | null): string[] | null {
    if (!WranglerClient.isAccountAmbiguity(detail)) return null;
    return [
      "your wrangler is logged in to multiple Cloudflare accounts, non-interactive mode cannot auto-select.",
      "specify one and rerun:",
      "",
      "  CLOUDFLARE_ACCOUNT_ID=<account_id> pnpm exec sz-ws-cms setup ...",
      "",
      "or write account_id to wrangler.jsonc. available accounts:",
      "",
      "  pnpm exec wrangler whoami",
    ];
  }

  async createD1(
    name: string,
  ): Promise<{ outcome: MutationOutcome; uuid: string | null }> {
    if (this.o.dryRun) return { outcome: { status: "planned" }, uuid: null };
    const r = await this.run(["d1", "create", name]);
    if (r.code !== 0) {
      return {
        outcome: { status: "failed", detail: (r.stderr || r.stdout).trim() },
        uuid: null,
      };
    }
    const uuid = parseCreatedD1Id(`${r.stdout}\n${r.stderr}`);
    if (!uuid) {
      return {
        outcome: {
          status: "failed",
          // 這裡最危險:資源已經建起來了,但我們讀不到 id。絕不能靜默略過。
          detail:
            `created D1 "${name}" but could not read database_id from wrangler output.` +
            ` run \`wrangler d1 list\` to get the id and manually enter it in wrangler.jsonc.`,
        },
        uuid: null,
      };
    }
    return { outcome: { status: "done" }, uuid };
  }

  /** R2 bucket 是否存在。null = 查不到(未登入 / 網路),不等於不存在。 */
  async r2Exists(name: string): Promise<boolean | null> {
    const r = await this.run(["r2", "bucket", "info", name]);
    if (r.code === 0) return true;
    const text = `${r.stdout}${r.stderr}`;
    // 只有「明確找不到」才算不存在;其他錯誤(401 / 網路)回 null,免得誤判成
    // 「不存在」→ 去建一個已經存在的 bucket。
    if (/not found|does not exist|10006|100[0-9]{2}/i.test(text)) return false;
    return null;
  }

  async createR2(name: string): Promise<MutationOutcome> {
    if (this.o.dryRun) return { status: "planned" };
    const r = await this.run(["r2", "bucket", "create", name]);
    if (r.code !== 0) {
      const text = `${r.stdout}${r.stderr}`;
      // 已存在 → 視為成功(冪等:重跑 setup 不該因為上次已建好而失敗)。
      if (/already (exists|owned)/i.test(text)) return { status: "done" };
      return { status: "failed", detail: (r.stderr || r.stdout).trim() };
    }
    return { status: "done" };
  }

  /**
   * 已設定的 secret 名稱清單。
   * null 代表查不到 —— 最常見的原因是 Worker 還沒 deploy 過(帳號上根本沒這個 Worker)。
   * 呼叫端必須把 null 當成「不知道」,而不是「沒有 SECRETS_KEY」。
   */
  async listSecrets(): Promise<string[] | null> {
    const r = await this.run(["secret", "list", "--format", "json"]);
    if (r.code !== 0) return null;
    try {
      const parsed = JSON.parse(r.stdout) as unknown;
      if (!Array.isArray(parsed)) return null;
      return (parsed as { name?: unknown }[])
        .map((s) => s?.name)
        .filter((n): n is string => typeof n === "string");
    } catch {
      return null;
    }
  }

  /** 值走 stdin,不進 argv —— argv 會被 `ps` 看到,也會留在 shell history 裡。 */
  async putSecret(key: string, value: string): Promise<MutationOutcome> {
    if (this.o.dryRun) return { status: "planned" };
    const r = await this.run(["secret", "put", key], value);
    if (r.code !== 0) {
      return { status: "failed", detail: (r.stderr || r.stdout).trim() };
    }
    return { status: "done" };
  }

  /**
   * 套用 migrations/。等同 `pnpm db:migrate:remote`
   * (= `wrangler d1 migrations apply <db> --remote`)。
   * wrangler 在非 TTY 下會跳過它自己的確認步驟 —— 我們的 stdio 是 pipe,所以不會卡住。
   */
  async applyMigrations(databaseName: string): Promise<MutationOutcome> {
    if (this.o.dryRun) return { status: "planned" };
    const r = await this.run(["d1", "migrations", "apply", databaseName, "--remote"]);
    if (r.code !== 0) {
      return { status: "failed", detail: (r.stderr || r.stdout).trim() };
    }
    return { status: "done" };
  }
}
