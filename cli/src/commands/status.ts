// `cms status`: one static, aligned report of the site. Read-only.

import type { Ctx, Outcome } from "../frame/context.js";
import { readSite } from "../site/site.js";
import type { StyleSet } from "../ui.js";
import { padVisual } from "../ui.js";
import { connect } from "./connect.js";
import { ago, field, plural, shortId, wrapJoin } from "./format.js";
import { gatherStatus, type ResourceRow, type StatusData } from "./status-data.js";

const ACCOUNT_FROM: Record<string, string> = {
  flag: "from --account",
  env: "from CLOUDFLARE_ACCOUNT_ID",
  config: "from wrangler.jsonc",
  "only-account": "the only account",
  chosen: "chosen now",
};

function mark(state: ResourceRow["state"], s: StyleSet): string {
  if (state === "ok") return s.green("✓");
  if (state === "missing") return s.red("✗");
  if (state === "unknown") return s.yellow("?");
  return s.dim("–");
}

function resourceNote(row: ResourceRow): string {
  if (row.state === "unknown") return "could not be read";
  if (row.pendingMigrations === null) return "pending migrations unknown";
  if (row.pendingMigrations) return `${plural(row.pendingMigrations.length, "migration")} pending`;
  return row.note ?? (row.state === "missing" ? "missing" : "");
}

function resourceLines(data: StatusData, s: StyleSet): string[] {
  const width = Math.max(...data.resources.map((r) => r.name.length)) + 3;
  return data.resources.map((r) =>
    `${mark(r.state, s)} ${padVisual(r.type, 9)}${padVisual(r.name, width)}${resourceNote(r)}`.trimEnd(),
  );
}

function secretsLine(data: StatusData): string {
  const managed = data.secrets.managed;
  if (managed.some((m) => m.set === null)) return "unknown (the Worker's secrets could not be read)";
  const missing = managed.filter((m) => !m.set).map((m) => m.name);
  const count = `${managed.length - missing.length} of ${managed.length} set`;
  return missing.length > 0 ? `${count}, missing ${missing.join(", ")}` : count;
}

export function renderStatus(data: StatusData, s: StyleSet, now: Date): string {
  const col = Math.max(data.site.worker.length, data.account.name.length, 16) + 3;
  const live = data.live
    ? `${padVisual(`version ${shortId(data.live.versionId)}`, col)}deployed ${ago(data.live.deployedAt, now)}`
    : "not deployed yet";
  const plugins = data.plugins.map((p) => (p.version ? `${p.id} ${p.version}` : p.id));
  return [
    ...field("Site", [`${padVisual(data.site.worker, col)}core ${data.site.core ?? "unknown"}`]),
    ...field("Account", [`${padVisual(data.account.name, col)}${data.auth.label}`]),
    ...field("", [s.dim(`${data.account.id} (${ACCOUNT_FROM[data.account.from] ?? data.account.from})`)]),
    ...field("Live", [live]),
    ...field("URLs", data.urls.length > 0 ? data.urls : ["none known"]),
    "",
    "Resources",
    ...resourceLines(data, s),
    "",
    ...field("Secrets", [secretsLine(data)]),
    ...field("Plugins", plugins.length > 0 ? wrapJoin(plugins, " · ", 66) : ["none"]),
  ].join("\n");
}

export async function runStatus(ctx: Ctx): Promise<Outcome> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const { cf, identity, account, port } = await connect(ctx, site.accountId);
  const data = await ctx.progress("Reading Cloudflare", () =>
    gatherStatus(ctx, {
      site,
      reads: port.account(account.id),
      account,
      auth: identity.source ?? { kind: "other", label: "cf credentials" },
      cfVersion: cf.version,
    }),
  );
  return { data, text: renderStatus(data, ctx.out, ctx.io.now()) };
}
