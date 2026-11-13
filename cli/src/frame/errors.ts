// The one error type of the new frame. Every failure that reaches the user is a
// CliError: a stable code, a one-line message, a hint and the next commands.

import { exitFor, type ExitCodeValue } from "./spec.js";

export interface CliErrorInit {
  code: string;
  message: string;
  hint?: string;
  next?: readonly string[];
  /** Command-specific detail for `error`-carrying envelopes (e.g. the accounts to pick from). */
  data?: unknown;
  /** Overrides the exit code that the error code maps to. */
  exit?: ExitCodeValue;
}

export class CliError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly next: readonly string[];
  readonly data: unknown;
  readonly exit: ExitCodeValue;

  constructor(init: CliErrorInit) {
    super(init.message);
    this.name = "CliError";
    this.code = init.code;
    this.hint = init.hint;
    this.next = init.next ?? [];
    this.data = init.data;
    this.exit = init.exit ?? exitFor(init.code);
  }
}

export function cancelled(): CliError {
  return new CliError({ code: "CANCELLED", message: "Cancelled. Nothing was changed." });
}

export function isCliError(e: unknown): e is CliError {
  return e instanceof CliError;
}
