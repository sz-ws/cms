// CLI 參數解析 —— 手寫小解析器(參數面極小,零依賴讓 `npx @sz.ws/cms` 免安裝)。
//
//   sz-cms add <id> [--source <url>] [--token <t>] [--dry-run] [--force]
//                 [--non-interactive] [--skip-core-check]
//   sz-cms --help | --version

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
  help: boolean;
  version: boolean;
  /** 解析層錯誤(未知旗標 / 缺旗標值);由呼叫端決定 exit code。 */
  error?: string;
}

const FLAGS_WITH_VALUE = new Set(["--source", "--token"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    dryRun: false,
    force: false,
    nonInteractive: false,
    skipCoreCheck: false,
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
    } else if (FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        out.error = `旗標 ${arg} 需要一個值`;
        return out;
      }
      if (arg === "--source") out.source = value;
      if (arg === "--token") out.token = value;
      i++;
    } else if (arg.startsWith("--source=")) {
      out.source = arg.slice("--source=".length);
    } else if (arg.startsWith("--token=")) {
      out.token = arg.slice("--token=".length);
    } else if (arg.startsWith("-")) {
      out.error = `未知旗標:${arg}`;
      return out;
    } else {
      positionals.push(arg);
    }
  }

  out.command = positionals[0];
  out.id = positionals[1];
  return out;
}
