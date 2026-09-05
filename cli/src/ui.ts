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
  /**
   * 不回顯的輸入。給 `secret: true` 的 extension setting 用 —— 那些值會被貼進
   * 終端,回顯等於留在 scrollback、也可能被錄影 / 螢幕分享看到。
   * 回傳值**絕不可以**進 transcript / UiEvent / reporter 的任何一行。
   */
  secret(question: string): Promise<string>;
}

// ---- 終端欄寬 -----------------------------------------------------------
// `String.length` 是 UTF-16 code unit 數,不是終端欄數:CJK 每字佔 **兩欄**,
// emoji 也是,組合附加符號佔 0 欄。拿 .length 去 padEnd 對齊,中文一多就整排歪掉。
// 這裡實作 East Asian Width 的近似版(涵蓋 CJK / 假名 / 諺文 / 全形 / 常用 emoji 區段)
// —— 完整的 EAW 表要幾百個區間,對 CLI 的對齊需求是過度工程;有漏的區段最壞只是
// 少算兩欄,不會壞掉。
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // 諺文字母
  [0x2e80, 0x303e], // CJK 部首、注音、日文標點
  [0x3041, 0x33ff], // 假名、諺文相容、CJK 相容
  [0x3400, 0x4dbf], // CJK 擴充 A
  [0x4e00, 0x9fff], // CJK 統一表意
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 諺文音節
  [0xf900, 0xfaff], // CJK 相容表意
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], // CJK 相容形式
  [0xff00, 0xff60], // 全形 ASCII
  [0xffe0, 0xffe6], // 全形符號
  [0x1f300, 0x1f64f], // 雜項符號與繪文字
  [0x1f900, 0x1f9ff], // 補充符號與繪文字
  [0x20000, 0x2fffd], // CJK 擴充 B+
  [0x30000, 0x3fffd],
];

// ANSI 用 new RegExp + 跳脫字串組出來,而不是正規表示式字面量 —— 字面量裡的 ESC
// 是**字面控制字元**,會讓 git / grep / 編輯器把整個檔案當成 binary。
const ANSI_RE = new RegExp("\\u001B\\[[0-9;]*m", "g");

function charWidth(cp: number): number {
  // 組合附加符號疊在前一個字上,不佔欄位。
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e) return 0; // ZWJ / 變異選擇子
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

/** 一段文字在終端佔幾欄。先剝掉 ANSI 色碼(它們不佔欄位)。 */
export function displayWidth(s: string): number {
  let total = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    total += charWidth(ch.codePointAt(0) ?? 0);
  }
  return total;
}

/** 以**欄寬**(非 .length)補右側空白到指定寬度;已經夠寬就原樣回傳。 */
export function padVisual(s: string, width: number): string {
  const gap = width - displayWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
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

/**
 * 給非動畫路徑的收尾行用;分鐘級的建置印成 125.4s 讀起來太吃力。
 *
 * 先把總秒數四捨五入、再拆成分秒。反過來(先拆再對秒數進位)會在 119.7s 印出
 * 「1m 60s」—— 一個不存在的時間。
 */
export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
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
      // 空行不補縮排 —— 否則區塊裡每個分隔行都會留下兩個尾隨空白,
      // 貼進 issue / diff 的時候很醜,有些編輯器還會標成錯誤。
      for (const line of lines) write(line ? `  ${line}\n` : "\n");
    },
    outro(lines) {
      write("\n");
      for (const line of lines) write(`${line}\n`);
    },
    async task(label, fn) {
      const started = Date.now();
      if (!o.animate) {
        // 只印開始行的話,CI 日誌裡「成功」「失敗」「還卡著」三種狀態長得一模一樣。
        // 轉圈那條路徑靠原地重繪表達進行中,這條沒有,只能補一行收尾。
        write(`${s.dim("…")} ${label}\n`);
        try {
          const value = await fn();
          write(`${colorFor("ok", s)(SYMBOL.ok)} ${label} (${formatElapsed(Date.now() - started)})\n`);
          return value;
        } catch (error) {
          write(`${colorFor("fail", s)(SYMBOL.fail)} ${label} (${formatElapsed(Date.now() - started)})\n`);
          throw error;
        }
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
      if (options.length === 0) throw new Error("select requires at least one option");
      onAnswer?.(question, options[0].label);
      return options[0].value;
    },
    async secret(question) {
      // 非互動下沒有人可以貼值進來。回空字串 = 「這一項沒填」,由呼叫端決定怎麼辦;
      // 這裡刻意**不呼叫 onAnswer**,secret 的問答一個字都不進記錄。
      void question;
      return "";
    },
  };
}

/**
 * 真的對著終端問。select 走數字選單而不是方向鍵:
 * 方向鍵要開 raw mode,在管線 / CI / 某些終端下會壞掉,而且壞的方式很難debug。
 * 數字選單在任何 stdin 都能用,程式碼也只有幾行。
 */
export function createTtyPrompter(): Prompter {
  const s = makeStyles(useColor && process.stderr.isTTY === true);

  async function ask(query: string): Promise<string> {
    // 問題本身不是結果 —— 跟其他人看的輸出一起走 stderr,stdout 保持乾淨。
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
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
      if (options.length === 0) throw new Error("select requires at least one option");
      process.stderr.write(`${question}\n`);
      options.forEach((opt, i) => {
        const hint = opt.hint ? s.dim(` — ${opt.hint}`) : "";
        process.stderr.write(`  ${s.cyan(String(i + 1))}. ${opt.label}${hint}\n`);
      });
      for (;;) {
        const raw = await ask(s.dim(`choose 1-${options.length} [1] `));
        if (raw === "") return options[0].value;
        const n = Number.parseInt(raw, 10);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) {
          return options[n - 1].value;
        }
        process.stderr.write(s.yellow(`  enter a number between 1 and ${options.length}.\n`));
      }
    },
    async secret(question) {
      // readline 沒有官方的「不回顯」開關。做法是接管它的輸出:提示字串放行一次,
      // 之後每一次 keystroke 觸發的重繪一律吞掉 —— 於是游標不動、打的字不出現。
      // (不用 raw mode 自己讀 byte:那條路要自己處理 backspace / Ctrl-C / 貼上,
      //  而且在管線與非 TTY 下行為分歧,壞法很難 debug。)
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
      });
      const internal = rl as unknown as { _writeToOutput?: (chunk: string) => void };
      let promptShown = false;
      internal._writeToOutput = (chunk: string) => {
        if (promptShown) return;
        promptShown = true;
        process.stderr.write(chunk);
      };
      try {
        const answer = await rl.question(`${question} ${s.dim("(hidden)")} `);
        process.stderr.write("\n");
        return answer.trim();
      } finally {
        rl.close();
      }
    },
  };
}

/** Reporter 收到的事件。--json 就是把這串原樣吐出來,不另外維護一套結構。 */
export type UiEvent =
  | { kind: "intro"; title: string; subtitle?: string }
  | { kind: "step"; status: StepStatus; message: string; detail?: string }
  | { kind: "note"; title: string; lines: string[] }
  | { kind: "outro"; lines: string[] }
  | { kind: "task"; label: string };

/**
 * 把 Reporter 的呼叫記下來。--json 需要一份機器可讀的輸出,而這支 CLI 的
 * 「結果」本來就是一連串步驟 —— 硬要為每條 return 路徑再定義一個結果型別,
 * 是把 600 行的流程改一遍去遷就輸出格式。這裡反過來:事件流就是結果。
 */
export function createEventCollector(): {
  events: UiEvent[];
  wrap(inner: Reporter): Reporter;
} {
  const events: UiEvent[] = [];
  return {
    events,
    wrap(inner) {
      return {
        intro(title, subtitle) {
          events.push({ kind: "intro", title, subtitle });
          inner.intro(title, subtitle);
        },
        step(status, message, detail) {
          events.push({ kind: "step", status, message, detail });
          inner.step(status, message, detail);
        },
        note(title, lines) {
          events.push({ kind: "note", title, lines: [...lines] });
          inner.note(title, lines);
        },
        outro(lines) {
          events.push({ kind: "outro", lines: [...lines] });
          inner.outro(lines);
        },
        task(label, fn) {
          events.push({ kind: "task", label });
          return inner.task(label, fn);
        },
      };
    },
  };
}

export interface UiBundle {
  reporter: Reporter;
  prompter: Prompter;
  styles: StyleSet;
  /** --json 時非 null;跑完由 cli.ts 序列化到 stdout。 */
  events: UiEvent[] | null;
}

/**
 * 依環境組出 UI。interactive=false(--yes / --non-interactive / 非 TTY)時
 * 用 auto prompter —— 流程完全不變,只是每個問題都取預設值。
 *
 * **進度與診斷一律走 stderr**,stdout 只留給「結果」(目前只有 --json 的那一份)。
 * 原本全部寫 stdout,後果是 `setup > log.txt` 會把轉圈字元、顏色碼跟真正想留的
 * 東西混在同一個檔裡,而任何想 pipe 這支 CLI 的腳本都得先想辦法濾掉它們。
 * 這也是 sz.ws 生態其他 CLI(@sz-ws/drop)已經在用的分法。
 */
export function createUi(opts: {
  interactive: boolean;
  /** 覆寫輸出目的地(測試用)。給了就等同非 TTY:不上色、不轉圈。 */
  write?: (chunk: string) => void;
  /** --json:仍然把人看的輸出寫到 stderr,另外收集事件供 stdout 用。 */
  json?: boolean;
}): UiBundle {
  const piped = opts.write !== undefined;
  const isTty = process.stderr.isTTY === true;
  const styles = makeStyles(useColor && isTty && !piped);
  const write = opts.write ?? ((chunk: string) => void process.stderr.write(chunk));
  const base = createReporter({
    write,
    animate: isTty && !piped,
    styles,
  });
  const collector = opts.json ? createEventCollector() : null;
  return {
    styles,
    reporter: collector ? collector.wrap(base) : base,
    prompter: opts.interactive ? createTtyPrompter() : createAutoPrompter(),
    events: collector?.events ?? null,
  };
}
