// `add` 裝完之後的設定問答。
//
// 讀剛裝好的 extensions/<id>/manifest.json,對每個 settings[] 問一輪,然後把答案
// 分流到兩個**互不重疊**的落點:
//
//   secret: false → wrangler.jsonc 的 vars      (進版控)
//   secret: true  → .dev.vars(本機、gitignored)+ 印出 `wrangler secret put`
//
// 🔴 cms 是公開 repo。secret 值寫進 vars 就是把它推上 GitHub。分流只有一處
// (settings.ts:storageFor),而且下面在寫入前還有一道 assert —— 兩層都被測試守著。
//
// 🔴 這裡**不會**自動執行 `wrangler secret put`:install 當下使用者可能還沒登入
// Cloudflare、Worker 也還沒 deploy(沒有東西可以掛 secret)。只印指令。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { persistDevVars } from "./devvars.js";
import {
  defaultAsText,
  envKeyFor,
  parseInputValue,
  readExtensionSettings,
  storageFor,
  type SettingField,
} from "./settings.js";
import type { Prompter, Reporter } from "./ui.js";
import { writeVars, type VarValue } from "./wrangler-config.js";

export interface ConfigureOptions {
  extensionsDir: string;
  /** wrangler.jsonc 的絕對路徑。 */
  configPath: string;
  /** .dev.vars 的絕對路徑。 */
  devVarsPath: string;
  extId: string;
  reporter: Reporter;
  prompter: Prompter;
  /** 非互動(--yes / --non-interactive / 非 TTY)時只列出要設什麼,不問也不寫。 */
  interactive: boolean;
}

export interface ConfigureResult {
  /** 寫進 wrangler.jsonc vars 的環境變數名。 */
  varsWritten: string[];
  /** 寫進 .dev.vars 的環境變數名(**不含值**)。 */
  devVarsWritten: string[];
  /** 要請使用者 deploy 後自己跑的指令。 */
  secretCommands: string[];
  /** 沒填的必填項 —— preflight 會再擋一次,這裡先講。 */
  unanswered: string[];
}

const EMPTY: ConfigureResult = {
  varsWritten: [],
  devVarsWritten: [],
  secretCommands: [],
  unanswered: [],
};

function questionFor(field: SettingField): string {
  return `${field.label} ${field.required ? "(required)" : "(optional, enter to skip)"}`;
}

/** 問一項。回傳 undefined 代表使用者跳過。 */
async function ask(
  p: Prompter,
  field: SettingField,
  reporter: Reporter,
): Promise<VarValue | undefined> {
  if (field.type === "boolean") {
    return p.confirm(questionFor(field), field.default === true);
  }
  if (field.type === "select") {
    return p.select(
      questionFor(field),
      field.options.map((o) => ({ label: o.label, value: o.value, hint: o.value })),
    );
  }
  if (field.secret) {
    // 不回顯。值一路只存在於這個變數與 .dev.vars,不進 reporter、不進 --json。
    const answer = await p.secret(questionFor(field));
    return answer === "" ? undefined : answer;
  }
  const answer = await p.text(questionFor(field), defaultAsText(field.default));
  if (answer === "") return undefined;
  const parsed = parseInputValue(field.type, answer);
  if (!parsed.ok) {
    reporter.step("warn", `${field.key}: ${parsed.error}`, "skipped, set it later.");
    return undefined;
  }
  return parsed.value;
}

/**
 * 跑一輪設定問答。沒有 manifest.json 或沒有 settings[] → 回 null(不是錯誤:
 * 程式碼型 extension 不一定帶 manifest)。
 */
export async function configureExtension(
  o: ConfigureOptions,
): Promise<ConfigureResult | null> {
  const { reporter: r, extId } = o;

  let found;
  try {
    found = await readExtensionSettings(o.extensionsDir, extId);
  } catch (e) {
    r.step("warn", `could not read extensions/${extId}/manifest.json`, e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!found || found.settings.length === 0) return null;
  for (const note of found.skipped) r.step("warn", `${extId} manifest: ${note}`);

  const secretKeys = found.settings
    .filter((f) => f.secret)
    .map((f) => envKeyFor(extId, f.key));

  if (!o.interactive) {
    // 沒有人可以回答。列出清單就好 —— 硬把 default 寫進 vars 只會產生一堆
    // 「看起來設定過了、其實是佔位值」的欄位,而 preflight 反而會因此放行。
    r.note(`${extId} settings (not prompted: non-interactive)`, [
      ...found.settings.map(
        (f) =>
          `${envKeyFor(extId, f.key)}  ${f.required ? "required" : "optional"}  → ${
            storageFor(f) === "vars" ? "wrangler.jsonc vars" : ".dev.vars + wrangler secret put"
          }`,
      ),
      "",
      "rerun `sz-ws-cms preflight` after filling them in.",
    ]);
    return { ...EMPTY, secretCommands: secretKeys.map(secretPutCommand) };
  }

  r.note(`${extId} settings`, [
    "answers go to wrangler.jsonc vars; `secret` ones go to .dev.vars (gitignored) instead,",
    "and are never written to wrangler.jsonc — that file is committed.",
  ]);

  const varValues = new Map<string, VarValue>();
  const secretValues = new Map<string, string>();
  const unanswered: string[] = [];

  for (const field of found.settings) {
    r.step("todo", field.label, field.description);
    const value = await ask(o.prompter, field, r);
    const envKey = envKeyFor(extId, field.key);
    if (value === undefined) {
      if (field.required) unanswered.push(envKey);
      continue;
    }
    if (storageFor(field) === "secret") {
      secretValues.set(envKey, String(value));
    } else {
      varValues.set(envKey, value);
    }
  }

  // 🔴 最後一道防線。上面的分流已經是唯一入口,但這行的存在是為了讓「secret 漏進
  // vars」變成一個會當場炸掉的程式錯誤,而不是一次安靜的資安事故。
  for (const field of found.settings) {
    if (field.secret && varValues.has(envKeyFor(extId, field.key))) {
      throw new Error(
        `refusing to write secret setting "${extId}.${field.key}" into wrangler.jsonc vars`,
      );
    }
  }

  const varsWritten = await persistVars(o, varValues);
  let devVarsWritten: string[] = [];
  try {
    devVarsWritten = await persistDevVars(o.devVarsPath, secretValues);
    if (devVarsWritten.length > 0) {
      // 只列鍵名,絕不列值。
      r.step("ok", `wrote ${devVarsWritten.length} secrets to .dev.vars`, devVarsWritten.join(", "));
    }
  } catch (e) {
    r.step("fail", "failed to write .dev.vars", e instanceof Error ? e.message : String(e));
  }

  const secretCommands = [...secretValues.keys()].map(secretPutCommand);
  if (secretCommands.length > 0) {
    r.note("set these on Cloudflare after deploying (this CLI will not run them for you)", [
      ...secretCommands,
      "",
      "not automated on purpose: you may not be logged in to Cloudflare yet, and the Worker",
      "may not exist — `wrangler secret put` needs both.",
    ]);
  }
  if (unanswered.length > 0) {
    r.step("warn", `${unanswered.length} required settings left empty`, unanswered.join(", "));
  }

  return { varsWritten, devVarsWritten, secretCommands, unanswered };
}

function secretPutCommand(envKey: string): string {
  return `  pnpm exec wrangler secret put ${envKey}`;
}

async function persistVars(
  o: ConfigureOptions,
  values: ReadonlyMap<string, VarValue>,
): Promise<string[]> {
  if (values.size === 0) return [];
  const { reporter: r } = o;
  try {
    // 寫前才讀 —— 註解與排版靠 jsonc.ts 的外科式編輯保留,詳見該檔檔頭。
    const text = await readFile(o.configPath, "utf8");
    const result = writeVars(text, values);
    if (result.changed.length === 0) {
      r.step("skip", `${path.basename(o.configPath)} vars already up to date`);
      return [];
    }
    await writeFile(o.configPath, result.text, "utf8");
    r.step("ok", `updated ${path.basename(o.configPath)} vars`, result.changed.join(", "));
    return result.changed;
  } catch (e) {
    r.step("fail", `failed to write ${path.basename(o.configPath)} vars`, e instanceof Error ? e.message : String(e));
    r.note("add these to the `vars` block manually", [
      ...[...values].map(([k, v]) => `"${k}": ${JSON.stringify(v)}`),
    ]);
    return [];
  }
}
