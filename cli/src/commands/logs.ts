// `cms logs`: live tail through the project's own wrangler. cf has no live tail
// for Workers (`cf cli search` finds only tunnel and video-stream commands), so
// this is a thin pass-through: wrangler gets the terminal and streams until Ctrl-C.
// wrangler uses its own login (or CLOUDFLARE_API_TOKEN), not cf's.

import { resolveWranglerCommand } from "../exec.js";
import type { Ctx, Outcome } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { readSite } from "../site/site.js";

export function tailArgs(worker: string, json: boolean, passthrough: readonly string[], configPath: string): string[] {
  return ["tail", worker, "--format", json ? "json" : "pretty", "--config", configPath, ...passthrough];
}

export async function runLogs(ctx: Ctx): Promise<Outcome | undefined> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
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
