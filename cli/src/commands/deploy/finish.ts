// After the new code is live: managed secrets, the site URL, the first
// administrator, and the readiness check.

import { bootstrapAdmin, type AdminCredentials } from "../../bootstrap.js";
import { bootstrapState } from "../../bootstrap-state.js";
import type { AccountApi } from "../../cloudflare/port.js";
import type { Ctx } from "../../frame/context.js";
import { CliError } from "../../frame/errors.js";
import { SETUP_TOKEN } from "../../secrets.js";
import type { Site } from "../../site/site.js";
import { ensureManagedSecrets } from "../managed-secrets.js";
import type { Inspection } from "./inspect.js";

/** Only a bare https origin (host and optional port) is ever written into SQL. */
const SAFE_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

export function siteOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    url = new URL("invalid:");
  }
  const origin = url.origin;
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !SAFE_ORIGIN_RE.test(origin)) {
    throw new CliError({ code: "BAD_VALUE", message: `--site-url must be an https origin such as https://www.example.com, not ${raw}.`, next: ["cms help deploy"] });
  }
  return origin;
}

/** The URL to initialise and check: --site-url, the workers.dev target wrangler reported, or the Worker's subdomain. */
export async function resolveOrigin(ctx: Ctx, site: Site, api: AccountApi, targets: readonly string[]): Promise<string> {
  if (typeof ctx.values["site-url"] === "string") return siteOrigin(ctx.values["site-url"]);
  const dev = targets.find((t) => new RegExp(`^https://${site.workerName}\\.[a-z0-9-]+\\.workers\\.dev$`).test(t));
  const fromWorker = dev ?? (await api.worker(site.workerName))?.workersDevUrl;
  if (fromWorker && SAFE_ORIGIN_RE.test(fromWorker)) return fromWorker;
  throw new CliError({
    code: "SITE_URL_UNKNOWN",
    message: "Could not tell the deployed URL (workers.dev is off and no --site-url was given).",
    next: ["cms deploy --site-url https://www.example.com"],
  });
}

export async function managedSecrets(i: Inspection, again: string, onToken: (value: string) => Promise<void>): Promise<string[]> {
  const result = await ensureManagedSecrets(i.api, i.site.workerName, {
    dryRun: false,
    again,
    onSetupToken: onToken,
  });
  return result.created;
}

/** INSERT only when absent: a custom domain set earlier is never replaced by workers.dev. */
export async function initSiteUrl(api: AccountApi, databaseId: string, origin: string): Promise<boolean> {
  const value = JSON.stringify(origin).replaceAll("'", "''");
  const rows = await api.d1Query(
    databaseId,
    `INSERT INTO settings (key, value, updated_at) VALUES ('core.siteUrl', '${value}', ${Date.now()}) ON CONFLICT(key) DO NOTHING RETURNING key`,
  );
  return rows.length > 0;
}

export async function usersNow(api: AccountApi, databaseId: string): Promise<number> {
  const count = (await api.d1Query(databaseId, "SELECT COUNT(*) AS count FROM users"))[0]?.count;
  if (typeof count !== "number") throw new Error("could not count the users of the site");
  return count;
}

export async function createFirstAdmin(ctx: Ctx, site: Site, databaseId: string, credentials: AdminCredentials, origin: string, token: string | undefined, again: string): Promise<void> {
  const recovery = bootstrapState(site.dir, site.workerName, databaseId);
  const setupToken = token || (await recovery.read());
  if (!setupToken) {
    throw new CliError({
      code: "ADMIN_FAILED",
      message: `${SETUP_TOKEN} exists on the Worker but its value is not known here; no key was rotated.`,
      hint: "Set CMS_SETUP_TOKEN to the value from the earlier deployment and run the command again.",
      next: [again],
    });
  }
  await bootstrapAdmin(origin, setupToken, credentials, ctx.fetch, ctx.sleep);
  await recovery.clear();
}

export async function checkLogin(ctx: Ctx, origin: string): Promise<void> {
  const response = await ctx.fetch(`${origin}/login`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  await response.body?.cancel();
  if (response.status !== 200) throw new Error(`${origin}/login answered HTTP ${response.status}`);
}
