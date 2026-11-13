// Prompts for the new frame: plain lines on stderr, never a full-screen UI.
// Ctrl-C or end of input while asking is a cancellation (exit 130), not a "no".

import * as readline from "node:readline/promises";
import { cancelled } from "./errors.js";
import type { StyleSet } from "../ui.js";

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

export interface Prompt {
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  select<T>(question: string, choices: readonly Choice<T>[]): Promise<T>;
  text(question: string): Promise<string>;
  /** Not echoed; the answer never reaches a log, a transcript or JSON. */
  secret(question: string): Promise<string>;
}

async function ask(query: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (hidden) {
    // readline has no "no echo" switch: let the prompt through once, swallow the redraws.
    const internal = rl as unknown as { _writeToOutput?: (chunk: string) => void };
    let shown = false;
    internal._writeToOutput = (chunk: string) => {
      if (shown) return;
      shown = true;
      process.stderr.write(chunk);
    };
  }
  const abort = new AbortController();
  rl.on("SIGINT", () => abort.abort());
  rl.on("close", () => abort.abort());
  try {
    return (await rl.question(query, { signal: abort.signal })).trim();
  } catch {
    process.stderr.write("\n");
    throw cancelled();
  } finally {
    rl.removeAllListeners("close");
    rl.close();
    if (hidden) process.stderr.write("\n");
  }
}

export function createTtyPrompt(s: StyleSet): Prompt {
  return {
    async confirm(question, defaultYes) {
      const answer = (await ask(`${s.cyan("?")}  ${question} ${s.dim(defaultYes ? "[Y/n]" : "[y/N]")} `)).toLowerCase();
      if (answer === "") return defaultYes;
      return answer === "y" || answer === "yes";
    },
    async select(question, choices) {
      process.stderr.write(`${s.cyan("?")}  ${question}\n`);
      choices.forEach((c, i) => {
        process.stderr.write(`   ${s.cyan(String(i + 1))}. ${c.label}${c.hint ? s.dim(`  ${c.hint}`) : ""}\n`);
      });
      for (;;) {
        const raw = await ask(`   ${s.dim(`1-${choices.length}, Ctrl-C to cancel:`)} `);
        const n = Number.parseInt(raw, 10);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
        process.stderr.write(`   ${s.yellow(`Enter a number from 1 to ${choices.length}.`)}\n`);
      }
    },
    text: (question) => ask(`${s.cyan("?")}  ${question}  ${s.dim("›")} `),
    secret: (question) => ask(`${s.cyan("?")}  ${question} ${s.dim("(hidden)")}  ${s.dim("›")} `, true),
  };
}

/** Used when nothing may be asked. Reaching it is a bug in the caller; fail loudly. */
export const noPrompt: Prompt = {
  confirm(question) {
    return Promise.reject(new Error(`internal: prompt while non-interactive: ${question}`));
  },
  select(question) {
    return Promise.reject(new Error(`internal: prompt while non-interactive: ${question}`));
  },
  text(question) {
    return Promise.reject(new Error(`internal: prompt while non-interactive: ${question}`));
  },
  secret(question) {
    return Promise.reject(new Error(`internal: prompt while non-interactive: ${question}`));
  },
};
