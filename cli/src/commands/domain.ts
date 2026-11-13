// `cms domain list | add <host> | remove <host>`: custom domains declared in
// wrangler.jsonc. Only the file changes here; Cloudflare attaches or detaches the
// domain at the next `cms deploy`. Remote data (core.siteUrl) is never touched.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Ctx, Outcome } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { readConfigText } from "../site/site.js";
import { addCustomDomain, declaredRoutes, hostProblem, removeRoute } from "../site/routes-edit.js";

function configPath(ctx: Ctx): string {
  return path.resolve(ctx.cwd, String(ctx.values.config));
}

function hostArgument(ctx: Ctx): string {
  const host = (ctx.positionals[0] ?? "").trim().toLowerCase();
  const problem = hostProblem(host);
  if (problem) throw new CliError({ code: "BAD_VALUE", message: problem, next: [`cms ${ctx.spec.name} www.example.com`] });
  return host;
}

export async function runDomainList(ctx: Ctx): Promise<Outcome> {
  const routes = declaredRoutes(await readConfigText(configPath(ctx)));
  const domains = routes.filter((r) => r.customDomain).map((r) => r.pattern);
  const other = routes.filter((r) => !r.customDomain).map((r) => r.pattern);
  const text = [
    ...(domains.length > 0 ? domains.map((d) => `${d}`) : ["No custom domains declared."]),
    ...(other.length > 0 ? ["", "Other routes (zone routes, kept as they are):", ...other.map((r) => `  ${r}`)] : []),
    "",
    "Declared in wrangler.jsonc; Cloudflare applies them at the next cms deploy.",
  ].join("\n");
  return { data: { domains, routes: other }, text };
}

async function rewrite(ctx: Ctx, edit: (text: string) => string): Promise<boolean> {
  const file = configPath(ctx);
  const before = await readConfigText(file);
  const after = edit(before);
  if (after === before) return false;
  if (ctx.values["dry-run"] !== true) await writeFile(file, after, "utf8");
  return true;
}

export async function runDomainAdd(ctx: Ctx): Promise<Outcome> {
  const host = hostArgument(ctx);
  const before = await readConfigText(configPath(ctx));
  const changed = await rewrite(ctx, (text) => addCustomDomain(text, host));
  const dryRun = ctx.values["dry-run"] === true;
  if (changed && !/"workers_dev"\s*:/.test(before)) {
    ctx.warn("WORKERS_DEV_OFF", 'With routes declared and no "workers_dev": true in wrangler.jsonc, the workers.dev address is turned off at the next deploy.');
  }
  ctx.warn(
    "SITE_URL_MAY_NEED_CHANGE",
    `If https://${host} becomes the site's main address, change core.siteUrl in admin → Settings after deploying (cms deploy only sets it when it is empty); sign-in redirects, payment callbacks and sitemap URLs are built from it.`,
  );
  return {
    data: { host, changed, dryRun, takesEffect: "next cms deploy" },
    plan: changed ? [{ action: "write", type: "config", name: `routes: ${host} (custom domain)` }] : [],
    text: changed
      ? `${dryRun ? "Would add" : "Added"} ${host} to wrangler.jsonc. It takes effect at the next cms deploy.\nnext: cms deploy --dry-run`
      : `${host} is already declared.`,
  };
}

export async function runDomainRemove(ctx: Ctx): Promise<Outcome> {
  const host = hostArgument(ctx);
  const known = declaredRoutes(await readFile(configPath(ctx), "utf8").catch(() => "{}")).some((r) => r.pattern === host);
  if (!known) throw new CliError({ code: "DOMAIN_NOT_FOUND", message: `${host} is not declared in wrangler.jsonc.`, next: ["cms domain list"] });
  const changed = await rewrite(ctx, (text) => removeRoute(text, host));
  const dryRun = ctx.values["dry-run"] === true;
  ctx.warn("DOMAIN_MAY_STAY_ATTACHED", `If ${host} is still attached to the Worker after the next deploy, detach it in the Cloudflare dashboard (the Worker's Domains & Routes); cms domain does not change anything remote.`);
  return {
    data: { host, changed, dryRun, takesEffect: "next cms deploy" },
    plan: [{ action: "remove", type: "config", name: `routes: ${host}` }],
    text: `${dryRun ? "Would remove" : "Removed"} ${host} from wrangler.jsonc. It is no longer declared from the next cms deploy on.\nnext: cms deploy --dry-run`,
  };
}
