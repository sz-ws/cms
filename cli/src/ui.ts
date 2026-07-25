// 終端 UI —— 零依賴,手寫。
//
// 為什麼不裝 @clack/prompts 之類的:
//   1. cli/ 不是 pnpm workspace 成員(repo 沒有 pnpm-workspace.yaml,也沒有 cli/node_modules)。
//      在 cli/package.json 宣告依賴不會被安裝,實際要能 import 得在**根** package.json
//      再宣告一次 —— 兩邊各一份、版本各自漂移,是個維護陷阱。
//   2. args.ts 開頭就寫著這支 CLI 刻意零依賴,讓 `npx @sz.ws/cms` 免安裝、冷啟動快。
//   3. `pnpm test:cli` 是純 node 且跑在半秒內,那個速度是資產。零依賴 = 零額外解析成本。
//
// 介面(Reporter / Prompter)是抽象的,所以 setup 流程完全不知道自己在對誰講話:
// 正式跑是 TTY,測試是腳本化的假 Prompter。互動與非互動共用同一條程式路徑。

import * as readline from "node:readline/promises";

// ---- 顏色 ---------------------------------------------------------------
// NO_COLOR 慣例 + 非 TTY 自動關閉,免得色碼汙染被導向檔案的輸出。
const useColor =
  process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

function paint(code: string, s: string, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${s}\u001b[0m` : s;
}

export interface StyleSet {
  dim(s: string): string;
  bold(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
}

export function makeStyles(enabled: boolean): StyleSet {
  return {
    dim: (s) => paint("2", s, enabled),
    bold: (s) => paint("1", s, enabled),
    green: (s) => paint("32", s, enabled),
    yellow: (s) => paint("33", s, enabled),
    red: (s) => paint("31", s, enabled),
    cyan: (s) => paint("36", s, enabled),
  };
}

export type StepStatus = "ok" | "skip" | "todo" | "warn" | "fail";

export interface Reporter {
  intro(title: string, subtitle?: string): void;
  /** 一行狀態。detail 走第二行縮排。 */
  step(status: StepStatus, message: string, detail?: string): void;
  note(title: string, lines: readonly string[]): void;
  /** 收尾:一定要講「接下來做什麼」。 */
  outro(lines: readonly string[]): void;
  /** 包住一段耗時操作;TTY 下轉圈,非 TTY 下退化成兩行純文字。 */
  task<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export interface SelectOption<T> {
  label: string;
  value: T;
  hint?: string;
}

export interface Prompter {
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  text(question: string, defaultValue?: string): Promise<string>;
  select<T>(question: string, options: readonly SelectOption<T>[]): Promise<T>;
}

const SYMBOL: Record<StepStatus, string> = {
  ok: "✓",
  skip: "•",
  todo: "→",
  warn: "⚠",
  fail: "✗",
};

function colorFor(status: StepStatus, s: StyleSet): (t: string) => string {
  switch (status) {
    case "ok":
      return s.green;
    case "skip":
      return s.dim;
    case "todo":
      return s.cyan;
    case "warn":
      return s.yellow;
    case "fail":
      return s.red;
  }
}

export interface StreamReporterOptions {
  write(chunk: string): void;
  /** TTY 才轉圈;測試與被導向的輸出一律關掉(否則輸出會塞滿控制碼)。 */
  animate: boolean;
  styles: StyleSet;
}

export function createReporter(o: StreamReporterOptions): Reporter {
  const { write, styles: s } = o;
  return {
    intro(title, subtitle) {
      write(`\n${s.bold(title)}\n`);
      if (subtitle) write(`${s.dim(subtitle)}\n`);
      write("\n");
    },
    step(status, message, detail) {
      write(`${colorFor(status, s)(SYMBOL[status])} ${message}\n`);
      if (detail) write(`  ${s.dim(detail)}\n`);
    },
    note(title, lines) {
      write(`\n${s.bold(title)}\n`);
      for (const line of lines) write(`  ${line}\n`);
    },
    outro(lines) {
      write("\n");
      for (const line of lines) write(`${line}\n`);
    },
    async task(label, fn) {
      if (!o.animate) {
        write(`${s.dim("…")} ${label}\n`);
        return fn();
      }
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let i = 0;
      write(`${frames[0]} ${label}`);
      const timer = setInterval(() => {
        i = (i + 1) % frames.length;
        write(`\r${frames[i]} ${label}`);
      }, 80);
      try {
        return await fn();
      } finally {
        clearInterval(timer);
        // 清掉整行,後續的 step() 才不會接在殘留的轉圈字元後面。
        write(`\r\u001b[2K`);
      }
    },
  };
}

/** 非互動模式的 Prompter:不問,直接用預設值,並把「自動選了什麼」記錄下來。 */
export function createAutoPrompter(
  onAnswer?: (question: string, answer: string) => void,
): Prompter {
  return {
    async confirm(question, defaultValue) {
      onAnswer?.(question, String(defaultValue));
      return defaultValue;
    },
    async text(question, defaultValue) {
      onAnswer?.(question, defaultValue ?? "");
      return defaultValue ?? "";
    },
    async select(question, options) {
      if (options.length === 0) throw new Error("select 需要至少一個選項");
      onAnswer?.(question, options[0].label);
      return options[0].value;
    },
  };
}

/**
 * 真的對著終端問。select 走數字選單而不是方向鍵:
 * 方向鍵要開 raw mode,在管線 / CI / 某些終端下會壞掉,而且壞的方式很難debug。
 * 數字選單在任何 stdin 都能用,程式碼也只有幾行。
 */
export function createTtyPrompter(): Prompter {
  const s = makeStyles(useColor && process.stdout.isTTY === true);

  async function ask(query: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return (await rl.question(query)).trim();
    } finally {
      rl.close();
    }
  }

  return {
    async confirm(question, defaultValue) {
      const hint = defaultValue ? "Y/n" : "y/N";
      const answer = (await ask(`${question} ${s.dim(`[${hint}]`)} `)).toLowerCase();
      if (answer === "") return defaultValue;
      return answer === "y" || answer === "yes";
    },
    async text(question, defaultValue) {
      const hint = defaultValue ? s.dim(` (${defaultValue})`) : "";
      const answer = await ask(`${question}${hint} `);
      return answer === "" ? (defaultValue ?? "") : answer;
    },
    async select(question, options) {
      if (options.length === 0) throw new Error("select 需要至少一個選項");
      process.stdout.write(`${question}\n`);
      options.forEach((opt, i) => {
        const hint = opt.hint ? s.dim(` — ${opt.hint}`) : "";
        process.stdout.write(`  ${s.cyan(String(i + 1))}. ${opt.label}${hint}\n`);
      });
      for (;;) {
        const raw = await ask(s.dim(`選擇 1-${options.length} [1] `));
        if (raw === "") return options[0].value;
        const n = Number.parseInt(raw, 10);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) {
          return options[n - 1].value;
        }
        process.stdout.write(s.yellow(`  請輸入 1 到 ${options.length} 之間的數字。\n`));
      }
    },
  };
}

export interface UiBundle {
  reporter: Reporter;
  prompter: Prompter;
  styles: StyleSet;
}

/**
 * 依環境組出 UI。interactive=false(--yes / --non-interactive / 非 TTY)時
 * 用 auto prompter —— 流程完全不變,只是每個問題都取預設值。
 */
export function createUi(opts: {
  interactive: boolean;
  write?: (chunk: string) => void;
}): UiBundle {
  const isTty = process.stdout.isTTY === true;
  const styles = makeStyles(useColor && isTty && opts.write === undefined);
  const write = opts.write ?? ((chunk: string) => void process.stdout.write(chunk));
  return {
    styles,
    reporter: createReporter({
      write,
      animate: isTty && opts.write === undefined,
      styles,
    }),
    prompter: opts.interactive ? createTtyPrompter() : createAutoPrompter(),
  };
}
