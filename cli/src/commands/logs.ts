// `cms logs`: live tail through the project's own wrangler. cf has no live tail
// for Workers (`cf cli search` finds only tunnel and video-stream commands), so
// this is a thin pass-through: wrangler gets the terminal and streams until Ctrl-C.
// wrangler uses its own login (or CLOUDFLARE_API_TOKEN), not cf's.
//
// `cms logs --since 15m` is different: recent errors from Workers Logs, through
// cf (`cf o11y telemetry query`). It needs observability enabled for the Worker.

import { resolveWranglerCommand } from "../exec.js";
import type { Ctx, Outcome } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { readSite, type Site } from "../site/site.js";
import type { LogEvent } from "../cloudflare/port.js";
import { connect } from "./connect.js";

export function tailArgs(worker: string, json: boolean, passthrough: readonly string[], configPath: string): string[] {
  return ["tail", worker, "--format", json ? "json" : "pretty", "--config", configPath, ...passthrough];
}

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
/** Workers Logs keeps events for 7 days. */
const MAX_SINCE_MS = 7 * 86_400_000;

export function sinceMs(value: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(value);
  const ms = m ? Number(m[1]) * UNITS[m[2]] : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_SINCE_MS ? ms : null;
}

function line(e: LogEvent): string {
  const outcome = e.outcome && e.outcome !== "ok" ? ` [${e.outcome}]` : "";
  return `${new Date(e.time).toISOString().slice(0, 19).replace("T", " ")}Z  ${e.level || "-"}  ${e.trigger ?? ""}${outcome}  ${e.message}`.replace(/ {3,}/g, "  ");
}

async function recentErrors(ctx: Ctx, site: Site): Promise<Outcome> {
  const span = sinceMs(String(ctx.values.since));
  const limit = Number(ctx.values.limit);
  if (span === null || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new CliError({ code: "BAD_VALUE", message: "--since takes 15m, 2h or 3d (at most 7d); --limit 1-500.", next: ["cms logs --since 15m"] });
  }
  const { port, account } = await connect(ctx, site.accountId);
  const now = ctx.io.now().getTime();
  const events = await ctx.progress("Reading Workers Logs", () => port.account(account.id).recentErrors(site.workerName, now - span, now, limit));
  const text = events.length === 0 ? `No errors from ${site.workerName} in the last ${String(ctx.values.since)}.` : events.map(line).join("\n");
  return { data: { worker: site.workerName, since: ctx.values.since, events }, text };
}

export async function runLogs(ctx: Ctx): Promise<Outcome | undefined> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  if (typeof ctx.values.since === "string") return recentErrors(ctx, site);
  const { cmd, prefix } = resolveWranglerCommand(ctx.cwd);
  const account = typeof ctx.values.account === "string" ? { CLOUDFLARE_ACCOUNT_ID: ctx.values.account } : undefined;
  if (!ctx.json) ctx.say(`Tailing ${site.workerName}. Ctrl-C to stop.`);
  const r = await ctx.exec(cmd, [...prefix, ...tailArgs(site.workerName, ctx.json, ctx.passthrough, site.configPath)], {
    cwd: ctx.cwd,
    inheritStdio: true,
    ...(account ? { env: account } : {}),
  });
  if (r.code === 0 || r.code === 130) return undefined;
  throw new CliError({
    code: "WRANGLER_FAILED",
    message: `wrangler tail exited with code ${r.code}.`,
    hint: "wrangler prints the reason above. It needs its own login (`pnpm exec wrangler login`) or CLOUDFLARE_API_TOKEN.",
    next: ["pnpm exec wrangler login", "cms logs"],
  });
}
