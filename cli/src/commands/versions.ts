// `cms version list`: uploaded versions, newest first, with the traffic share
// each one serves in the latest deployment.

import type { Ctx, Outcome } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { readSite } from "../site/site.js";
import { padVisual } from "../ui.js";
import { connect } from "./connect.js";
import { utc } from "./format.js";

export interface VersionRow {
  id: string;
  number: number | null;
  createdAt: string;
  source: string | null;
  message: string | null;
  tag: string | null;
  /** Percent of traffic in the latest deployment; 0 when not deployed. */
  traffic: number;
}

function limitOf(ctx: Ctx): number {
  const n = Number(ctx.values.limit);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new CliError({ code: "BAD_VALUE", message: "--limit must be a whole number from 1 to 100.", next: ["cms help version list"] });
  }
  return n;
}

export function renderVersions(worker: string, rows: readonly VersionRow[]): string {
  if (rows.length === 0) return `No versions of ${worker} yet.`;
  const header = ["Version", "No.", "Created", "Traffic", "Source", "Message"];
  const table = rows.map((r) => [r.id, r.number === null ? "" : String(r.number), utc(r.createdAt), r.traffic > 0 ? `${r.traffic}%` : "", r.source ?? "", r.message ?? r.tag ?? ""]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)) + 2);
  return [header, ...table].map((row) => row.map((cell, i) => padVisual(cell, widths[i])).join("").trimEnd()).join("\n");
}

export async function runVersionList(ctx: Ctx): Promise<Outcome> {
  const limit = limitOf(ctx);
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const { port, account } = await connect(ctx, site.accountId);
  const reads = port.account(account.id);
  const [versions, deployments] = await ctx.progress("Reading versions", () =>
    Promise.all([reads.versions(site.workerName, limit), reads.deployments(site.workerName, 1)]),
  );
  if (versions === null) {
    throw new CliError({
      code: "WORKER_NOT_FOUND",
      message: `The Worker ${site.workerName} does not exist on this account yet.`,
      hint: "Deploy the site first.",
      next: ["cms deploy", "cms status"],
    });
  }
  const traffic = new Map((deployments?.[0]?.versions ?? []).map((v) => [v.versionId, v.percentage]));
  const rows: VersionRow[] = versions.map((v) => ({
    id: v.id,
    number: v.number ?? null,
    createdAt: v.createdOn,
    source: v.source ?? null,
    message: v.message ?? null,
    tag: v.tag ?? null,
    traffic: traffic.get(v.id) ?? 0,
  }));
  return { data: { worker: site.workerName, versions: rows }, text: renderVersions(site.workerName, rows) };
}
