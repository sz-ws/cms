// One line per deploy step, with how long it took. Child output goes to a log file
// under .cms/logs/ instead of the terminal; a failing step names that file. Lines
// are plain and printed once; only the running step redraws (a spinner on a TTY).
// Ctrl-C ends the run at the current step and lists what was completed.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ensureCmsIgnored } from "../../bootstrap-state.js";
import { CloudflareError } from "../../cloudflare/port.js";
import { isProgramMissing, type ExecResult } from "../../exec.js";
import { fromCloudflare, fromMissingProgram } from "../../frame/output.js";
import type { Ctx } from "../../frame/context.js";
import { CliError, isCliError } from "../../frame/errors.js";
import { formatElapsed, padVisual } from "../../ui.js";

export interface CompletedStep {
  name: string;
  detail: string;
  ms: number;
}

export class DeployLog {
  readonly file: string;
  private ready = false;

  constructor(private readonly siteDir: string, now: Date) {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    this.file = path.join(siteDir, ".cms", "logs", `deploy-${stamp}.log`);
  }

  /** The path to show people: relative to the site. */
  get shown(): string {
    return path.relative(this.siteDir, this.file);
  }

  async write(text: string): Promise<void> {
    if (!this.ready) {
      await ensureCmsIgnored(this.siteDir);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      this.ready = true;
    }
    await appendFile(this.file, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
  }

  async command(cmd: string, args: readonly string[], result: ExecResult): Promise<void> {
    await this.write(`$ ${[path.basename(cmd), ...args].join(" ")}\n${result.stdout}${result.stderr}\n[exit ${result.code}]\n`);
  }
}

export interface StepFailure {
  code: string;
  message: string;
  hint?: string;
  next?: string[];
}

export class Steps {
  readonly completed: CompletedStep[] = [];
  private interrupted = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly ctx: Ctx, readonly log: DeployLog, private readonly again: string) {
    this.unsubscribe = ctx.onInterrupt(() => {
      this.interrupted = true;
    });
  }

  close(): void {
    this.unsubscribe();
  }

  private line(mark: string, name: string, detail: string, ms?: number): void {
    const time = ms === undefined ? "" : `  ${this.ctx.err.dim(formatElapsed(ms))}`;
    this.ctx.say(`${mark}  ${padVisual(name, 14)}${detail}${time}`.trimEnd());
  }

  private cancelled(): CliError {
    return new CliError({
      code: "CANCELLED",
      message: `Stopped. ${this.completed.length > 0 ? `Completed: ${this.completed.map((s) => s.name).join(", ")}.` : "No step had completed."}`,
      hint: `Run \`${this.again}\` again to continue from what is missing.`,
      next: [this.again],
    });
  }

  /**
   * Run one step. `fn` returns the detail shown after the name. A thrown error
   * that is not a CliError becomes `failure` with the log file as the hint.
   */
  async run<T>(name: string, failure: StepFailure, fn: () => Promise<{ value: T; detail?: string }>): Promise<T> {
    if (this.interrupted) throw this.cancelled();
    const started = Date.now();
    try {
      const { value, detail } = await this.ctx.progress(name, fn);
      if (this.interrupted) throw this.cancelled();
      const ms = Date.now() - started;
      this.completed.push({ name, detail: detail ?? "", ms });
      this.line(this.ctx.err.green("✓"), name, detail ?? "", ms);
      return value;
    } catch (e) {
      if (this.interrupted) throw this.cancelled();
      this.line(this.ctx.err.red("✗"), name, "failed", Date.now() - started);
      if (isCliError(e)) throw e;
      if (isProgramMissing(e)) throw fromMissingProgram(e, this.again);
      // Sign-in, permission and transient failures keep their own codes (exit 3 / 5).
      if (e instanceof CloudflareError && e.failure !== "FAILED" && e.failure !== "NOT_FOUND") throw fromCloudflare(e, this.again);
      const reason = e instanceof Error ? e.message : String(e);
      throw new CliError({
        code: failure.code,
        message: `${failure.message}: ${reason}`,
        hint: `${failure.hint ? `${failure.hint} ` : ""}Log: ${this.log.shown}`,
        next: failure.next ?? [this.again],
      });
    }
  }

  /** A step that was not needed this time, shown so the list stays complete. */
  skip(name: string, detail: string): void {
    this.line(this.ctx.err.dim("–"), name, detail);
  }
}
