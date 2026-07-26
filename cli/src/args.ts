// CLI 參數解析 —— 手寫小解析器(參數面極小,零依賴讓 `npx @sz.ws/cms` 免安裝)。
//
//   sz-ws-cms add <id> [--source <url>] [--token <t>] [--dry-run] [--force]
//                 [--non-interactive] [--skip-core-check]
//   sz-ws-cms setup [--config <path>] [--site-slug <slug>] [--dry-run] [--yes]
//                [--skip-migrations] [--skip-secrets]
//   sz-ws-cms --help | --version

export const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

export interface ParsedArgs {
  command?: string;
  id?: string;
  source?: string;
  token?: string;
  dryRun: boolean;
  force: boolean;
  nonInteractive: boolean;
  /** 跳過 coreApi 相容性檢查(squash 期間 / 本機改過 CORE_API_VERSION 的逃生門)。 */
  skipCoreCheck: boolean;
  // ---- setup ----
  /** 覆寫 wrangler 設定檔路徑(預設 <cwd>/wrangler.jsonc)。 */
  config?: string;
  /** 新 clone 的唯一站點識別;由 setup 衍生 Worker/D1/R2 名稱。 */
  siteSlug?: string;
  /** 僅限明確單站/開發帳號使用 shipped 的共用資源名稱。 */
  allowSharedDefaultNames: boolean;
  /** 略過所有確認關卡。CI 用;與 --non-interactive 同義。 */
  yes: boolean;
  skipMigrations: boolean;
  skipSecrets: boolean;
  /** 機器可讀輸出:人看的東西照樣走 stderr,stdout 只放一份 JSON。 */
  json: boolean;
  help: boolean;
  version: boolean;
  /** 解析層錯誤(未知旗標 / 缺旗標值);由呼叫端決定 exit code。 */
  error?: string;
}

const FLAGS_WITH_VALUE = new Set(["--source", "--token", "--config", "--site-slug"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    dryRun: false,
    force: false,
    nonInteractive: false,
    skipCoreCheck: false,
    allowSharedDefaultNames: false,
    yes: false,
    skipMigrations: false,
    skipSecrets: false,
    json: false,
    help: false,
    version: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--version" || arg === "-v") {
      out.version = true;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--force") {
      out.force = true;
    } else if (arg === "--non-interactive") {
      out.nonInteractive = true;
    } else if (arg === "--skip-core-check") {
      out.skipCoreCheck = true;
    } else if (arg === "--yes" || arg === "-y") {
      out.yes = true;
    } else if (arg === "--skip-migrations") {
      out.skipMigrations = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--skip-secrets") {
      out.skipSecrets = true;
    } else if (arg === "--allow-shared-default-names") {
      out.allowSharedDefaultNames = true;
    } else if (FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        out.error = `flag ${arg} requires a value`;
        return out;
      }
      if (arg === "--source") out.source = value;
      if (arg === "--token") out.token = value;
      if (arg === "--config") out.config = value;
      if (arg === "--site-slug") out.siteSlug = value;
      i++;
    } else if (arg.startsWith("--source=")) {
      out.source = arg.slice("--source=".length);
    } else if (arg.startsWith("--token=")) {
      out.token = arg.slice("--token=".length);
    } else if (arg.startsWith("--config=")) {
      out.config = arg.slice("--config=".length);
    } else if (arg.startsWith("--site-slug=")) {
      out.siteSlug = arg.slice("--site-slug=".length);
    } else if (arg.startsWith("-")) {
      out.error = `unknown flag: ${arg}`;
      return out;
    } else {
      positionals.push(arg);
    }
  }

  out.command = positionals[0];
  out.id = positionals[1];
  return out;
}
