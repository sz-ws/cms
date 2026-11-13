// First-run inputs: the site name, the first administrator, and (rarely) a setup
// token from an earlier run. Each one is a flag or an environment variable; a
// person at a terminal is asked for what is missing, anyone else gets
// INPUT_REQUIRED with the list. Passwords and tokens come only from the
// environment or a hidden prompt, never from argv.

import type { AdminCredentials } from "../../bootstrap.js";
import type { Ctx } from "../../frame/context.js";
import { CliError } from "../../frame/errors.js";
import { validateSiteName } from "../../site/naming.js";

export interface MissingInput {
  input: string;
  flag?: string;
  env: string;
  secret?: boolean;
}

export const NAME_INPUT: MissingInput = { input: "site name", flag: "--name", env: "CMS_SITE_NAME" };

/** Why a value is not acceptable, or null when it is. */
type Check = (value: string) => string | null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const needed = (what: string): Check => (v) => (v ? null : `The ${what} cannot be empty.`);

interface AdminInput extends MissingInput {
  key: keyof AdminCredentials;
  prompt: string;
  check: Check;
}

const ADMIN_INPUTS: readonly AdminInput[] = [
  { key: "email", input: "administrator email", flag: "--admin-email", env: "CMS_ADMIN_EMAIL", prompt: "Administrator email", check: (v) => (EMAIL_RE.test(v) ? null : "That is not an email address.") },
  { key: "name", input: "administrator name", flag: "--admin-name", env: "CMS_ADMIN_NAME", prompt: "Administrator name", check: needed("administrator name") },
  { key: "siteTitle", input: "site title", flag: "--site-title", env: "CMS_SITE_TITLE", prompt: "Site title", check: needed("site title") },
  { key: "password", input: "administrator password", env: "CMS_ADMIN_PASSWORD", secret: true, prompt: "Administrator password (8 characters or more)", check: (v) => (v.length >= 8 ? null : "The password needs 8 characters or more.") },
];

export const SETUP_TOKEN_INPUT: MissingInput = { input: "setup token from the earlier deployment", env: "CMS_SETUP_TOKEN", secret: true };

export function inputRequired(missing: readonly MissingInput[], again: string): CliError {
  return new CliError({
    code: "INPUT_REQUIRED",
    message: `Missing: ${missing.map((m) => m.input).join(", ")}.`,
    hint: `Set ${missing.map((m) => (m.flag ? `${m.flag} or ${m.env}` : m.env)).join("; ")}. Passwords and tokens only through the environment.`,
    next: [again],
    data: { missing },
  });
}

function given(ctx: Ctx, m: MissingInput): string {
  const fromFlag = m.flag ? ctx.values[m.flag.slice(2)] : undefined;
  const value = typeof fromFlag === "string" ? fromFlag : ctx.io.env[m.env] ?? "";
  return m.secret ? value : value.trim();
}

/**
 * Ask until the answer passes `check`; an invalid answer says why and asks again.
 * Ctrl-C (or end of input) cancels with 130 inside the prompt.
 */
export async function askUntilValid(ctx: Ctx, question: string, check: Check, secret = false): Promise<string> {
  for (;;) {
    const raw = secret ? await ctx.prompt.secret(question) : await ctx.prompt.text(question);
    const answer = secret ? raw : raw.trim();
    const problem = check(answer);
    if (!problem) return answer;
    ctx.say(`${ctx.err.yellow("!")}  ${problem}`);
  }
}

/** A value given by flag or env must be valid at once; there is nobody to ask again. */
function invalidGiven(ctx: Ctx, m: MissingInput, problem: string, again: string): CliError {
  const source = m.flag && typeof ctx.values[m.flag.slice(2)] === "string" && ctx.explicit.has(m.flag.slice(2)) ? m.flag : m.env;
  return new CliError({ code: "BAD_VALUE", message: `${source}: ${problem}`, hint: `Fix ${source}.`, next: [again] });
}

/** Admin inputs that are not given; empty when a prompt may fill them. */
export function missingAdminInputs(ctx: Ctx): MissingInput[] {
  return ctx.interactive ? [] : ADMIN_INPUTS.filter((m) => given(ctx, m) === "").map(({ input, flag, env, secret }) => ({ input, flag, env, secret }));
}

const nameCheck: Check = (v) => (validateSiteName(v) ? `"${v}" cannot be a site name. ${validateSiteName(v)}` : null);

export async function siteNameInput(ctx: Ctx, again: string): Promise<string> {
  const name = given(ctx, NAME_INPUT);
  if (name) {
    const problem = nameCheck(name);
    if (problem) throw invalidGiven(ctx, NAME_INPUT, problem, again);
    return name;
  }
  if (!ctx.interactive) throw inputRequired([NAME_INPUT, ...missingAdminInputs(ctx)], again);
  return askUntilValid(ctx, "Site name (lowercase, e.g. acme)", nameCheck);
}

export async function adminInputs(ctx: Ctx, again: string): Promise<AdminCredentials> {
  const missing = missingAdminInputs(ctx);
  if (missing.length > 0) throw inputRequired(missing, again);
  const values: Partial<AdminCredentials> = {};
  for (const m of ADMIN_INPUTS) {
    const value = given(ctx, m);
    const problem = value ? m.check(value) : null;
    if (problem) throw invalidGiven(ctx, m, problem, again);
    values[m.key] = value || (await askUntilValid(ctx, m.prompt, m.check, m.secret));
  }
  return values as AdminCredentials;
}

export async function setupTokenInput(ctx: Ctx, saved: string, again: string): Promise<string> {
  const token = ctx.io.env.CMS_SETUP_TOKEN?.trim() || saved;
  if (token) return token;
  if (!ctx.interactive) throw inputRequired([SETUP_TOKEN_INPUT], again);
  return askUntilValid(ctx, "SETUP_TOKEN is already set on the Worker and cannot be read back. Its value from the earlier deployment", needed("setup token"), true);
}
