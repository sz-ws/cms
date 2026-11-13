// `cms destroy`: delete this site's Cloudflare resources, after a plan and a typed
// confirmation of the Worker name. Only resources this site's wrangler.jsonc names
// are touched: the Worker (and with it its custom domains), the D1 databases by id,
// the R2 buckets by name, KV namespaces by id. A non-empty bucket is refused
// (BUCKET_NOT_EMPTY) unless --purge-objects, which deletes the bucket's objects
// first (purge.ts). Order: Worker, D1, R2 (objects, then bucket), KV.

import type { AccountApi } from "../cloudflare/port.js";
import type { Ctx, Outcome, PlanItem } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { toCliError } from "../frame/output.js";
import { readSite, type Site } from "../site/site.js";
import { againCommand, connect } from "./connect.js";
import { withFlag } from "./confirm.js";
import { countObjects, describeCount, purgeBucket } from "./purge.js";

interface Doomed {
  item: PlanItem;
  /** May return a detail for the done line (e.g. how many objects were deleted). */
  remove: () => Promise<string | void>;
}

interface Inventory {
  doomed: Doomed[];
  nonEmpty: string[];
  notes: string[];
}

async function bucketItems(ctx: Ctx, api: AccountApi, bucket: string, nonEmpty: string[]): Promise<Doomed[]> {
  const bucketItem: Doomed = { item: { action: "delete", type: "r2", name: bucket }, remove: async () => api.r2Delete(bucket) };
  if (ctx.values["purge-objects"] !== true) {
    if (await api.r2HasObjects(bucket)) nonEmpty.push(bucket);
    return [bucketItem];
  }
  const count = await countObjects(api, bucket);
  if (count.count === 0) return [bucketItem];
  const purge: Doomed = {
    item: { action: "delete", type: "objects", name: `${bucket}: ${describeCount(count)}` },
    remove: async () => `${await purgeBucket(ctx, api, bucket)} objects`,
  };
  return [purge, bucketItem];
}

async function inventory(ctx: Ctx, site: Site, api: AccountApi): Promise<Inventory> {
  const w = site.workerName;
  const [worker, d1, kv] = await Promise.all([api.worker(w), api.d1List(), site.kvIds.length > 0 ? api.kvList() : Promise.resolve([])]);
  const domains = site.routes.filter((r) => r.customDomain).map((r) => r.url.replace(/^https:\/\//, ""));
  const doomed: Doomed[] = [];
  // The site's WORKER_SELF_REFERENCE makes the Worker reference itself; only then is
  // --delete-with-references safe. Another Worker's binding is never broken silently.
  const others = (worker?.referencedBy ?? []).filter((n) => n !== w);
  if (others.length > 0) throw new CliError({ code: "WORKER_REFERENCED", message: `${others.join(", ")} still ${others.length === 1 ? "binds" : "bind"} to ${w}; deleting it would break ${others.length === 1 ? "that Worker" : "them"}. Nothing was deleted.`, next: ["cms status"] });
  const selfOnly = (worker?.referencedBy ?? []).includes(w);
  if (worker) doomed.push({ item: { action: "delete", type: "worker", name: domains.length > 0 ? `${w} (with ${domains.join(", ")})` : w }, remove: () => api.deleteWorker(w, selfOnly) });
  for (const db of site.d1.filter((d) => d.id && d1.some((x) => x.id === d.id))) {
    doomed.push({ item: { action: "delete", type: "d1", name: `${db.name} (${db.id})` }, remove: () => api.d1Delete(db.id!) });
  }
  const nonEmpty: string[] = [];
  for (const bucket of site.r2) {
    if (await api.r2Exists(bucket.name)) doomed.push(...(await bucketItems(ctx, api, bucket.name, nonEmpty)));
  }
  for (const ns of kv.filter((n) => site.kvIds.includes(n.id))) {
    doomed.push({ item: { action: "delete", type: "kv", name: `${ns.title} (${ns.id})` }, remove: () => api.kvDelete(ns.id) });
  }
  const notes = site.d1.filter((d) => !d.id).map((d) => `${d.name} has no database_id in wrangler.jsonc and is left alone.`);
  return { doomed, nonEmpty, notes };
}

function planText(site: Site, inv: Inventory): string[] {
  const db = site.d1.find((d) => d.id)?.name;
  return [
    "   Plan (cannot be undone)",
    ...inv.doomed.map(({ item }) => `   - ${item.type.padEnd(8)}${item.name}${item.type === "objects" ? " (deleted first)" : ""}${inv.nonEmpty.includes(item.name) ? "  (not empty: refused without --purge-objects)" : ""}`),
    ...(db ? ["", `   Back up first: pnpm exec wrangler d1 export ${db} --remote --output backup.sql`] : []),
  ];
}

function notEmpty(ctx: Ctx, inv: Inventory): CliError {
  return new CliError({
    code: "BUCKET_NOT_EMPTY",
    message: `Not deleting anything: ${inv.nonEmpty.join(", ")} still ${inv.nonEmpty.length === 1 ? "holds" : "hold"} objects.`,
    hint: "Add --purge-objects to delete the objects first (they are gone for good), or empty the bucket in the Cloudflare dashboard and run the command again.",
    next: [withFlag(againCommand(ctx), "--purge-objects"), againCommand(ctx)],
    data: { plan: inv.doomed.map((d) => d.item) },
  });
}

async function confirmName(ctx: Ctx, worker: string): Promise<void> {
  const given = typeof ctx.values.confirm === "string" ? ctx.values.confirm : undefined;
  if (given !== undefined && given !== worker) {
    throw new CliError({ code: "BAD_VALUE", message: `--confirm ${given} does not match the Worker name ${worker}; nothing was deleted.`, next: ["cms destroy --dry-run"] });
  }
  if (given === worker && ctx.values.yes === true) return;
  if (!ctx.interactive) {
    throw new CliError({
      code: "CONFIRMATION_REQUIRED",
      message: "Deleting a site needs --yes and --confirm <worker-name> together.",
      next: [withFlag(againCommand(ctx), "--dry-run"), `cms destroy --yes --confirm ${worker}`],
    });
  }
  const typed = (await ctx.prompt.text(`Type the Worker name (${worker}) to delete everything above`)).trim();
  if (typed !== worker) throw new CliError({ code: "CANCELLED", message: "Nothing was deleted.", hint: `The name typed was not ${worker}.` });
}

async function remove(ctx: Ctx, doomed: Doomed[]): Promise<string[]> {
  const done: string[] = [];
  for (const d of doomed) {
    try {
      // Purging writes its own running count, so it gets no spinner.
      const detail = d.item.type === "objects" ? await d.remove() : await ctx.progress(`Deleting ${d.item.type} ${d.item.name}`, d.remove);
      ctx.say(`${ctx.err.green("✓")}  Deleted ${d.item.type} ${d.item.type === "objects" && detail ? `${detail} from ${d.item.name.split(":")[0]}` : d.item.name}`);
      done.push(`${d.item.type} ${d.item.name}`);
    } catch (e) {
      const error = toCliError(e, againCommand(ctx));
      throw new CliError({ code: error.code, message: error.message, hint: [error.hint, `Deleted so far: ${done.join(", ") || "nothing"}.`].filter(Boolean).join(" "), next: [...error.next], data: { deleted: done }, exit: error.exit });
    }
  }
  return done;
}

export async function runDestroy(ctx: Ctx): Promise<Outcome> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const { port, account } = await connect(ctx, site.accountId);
  const inv = await ctx.progress("Reading Cloudflare", () => inventory(ctx, site, port.account(account.id)));
  for (const note of inv.notes) ctx.warn("NOT_OWNED", note);
  const plan = inv.doomed.map((d) => d.item);
  if (plan.length === 0) return { data: { worker: site.workerName, deleted: [] }, plan, text: `Nothing of ${site.workerName} exists on this account.` };
  const text = planText(site, inv).join("\n");
  if (inv.nonEmpty.length > 0) return { data: { worker: site.workerName }, plan, text, error: notEmpty(ctx, inv) };
  if (ctx.values["dry-run"] === true) return { data: { worker: site.workerName, dryRun: true }, plan, text: `${text}\n\n   Dry run: nothing was deleted.` };
  if (!ctx.json) ctx.say(`\n${text}\n`);
  await confirmName(ctx, site.workerName);
  const deleted = await remove(ctx, inv.doomed);
  return { data: { worker: site.workerName, deleted }, plan, text: `Deleted ${deleted.length} ${deleted.length === 1 ? "resource" : "resources"} of ${site.workerName}.` };
}
