// The plan: everything `cms deploy` will change, as data (plan[] in JSON) and as
// the short list a person confirms. Nothing in the project or on Cloudflare has
// changed when this is shown.

import path from "node:path";
import type { PlanItem } from "../../frame/context.js";
import { PAGE_CACHE_RULE } from "../../site/page-cache.js";
import type { StyleSet } from "../../ui.js";
import { padVisual } from "../../ui.js";
import { plural } from "../format.js";
import type { Inspection } from "./inspect.js";

function configItems(i: Inspection): PlanItem[] {
  const config = path.basename(i.site.configPath);
  return [
    ...(i.renamedText !== null ? [{ action: "write", type: "config", name: `${config}: site name ${i.site.workerName.replace(/^cms-/, "")}` }] : []),
    ...(i.writeAccount ? [{ action: "write", type: "config", name: `${config}: account_id` }] : []),
    ...i.d1.filter((d) => d.writeId && d.existingId).map((d) => ({ action: "write", type: "config", name: `${config}: database_id of ${d.name}` })),
  ];
}

function resourceItems(i: Inspection): PlanItem[] {
  return [
    ...(i.workerExists ? [] : [{ action: "create", type: "worker", name: i.site.workerName }]),
    ...i.d1.filter((d) => !d.existingId).map((d) => ({ action: "create", type: "d1", name: d.name })),
    ...i.r2.filter((b) => b.create).map((b) => ({ action: "create", type: "r2", name: b.name })),
    ...(i.pageCache?.verdict.kind === "add" ? [{ action: "create", type: "lifecycle-rule", name: `${PAGE_CACHE_RULE} on ${i.pageCache.bucket}` }] : []),
  ];
}

function releaseItems(i: Inspection): PlanItem[] {
  const migrations = i.d1.filter((d) => d.pending.length > 0).map((d) => ({ action: "apply", type: "migrations", name: `${d.name}: ${plural(d.pending.length, "migration")}` }));
  const worker = i.site.workerName;
  const release = i.workerExists
    ? [{ action: "upload", type: "version", name: `${worker} (not live)` }, ...migrations, { action: "promote", type: "version", name: `${worker} to 100%` }]
    : [...migrations, { action: "deploy", type: "worker", name: worker }];
  return [{ action: "install", type: "dependencies", name: "locked versions" }, { action: "build", type: "worker", name: worker }, ...release];
}

function finishItems(i: Inspection): PlanItem[] {
  return [
    ...i.secretsMissing.map((name) => ({ action: "create", type: "secret", name })),
    ...(i.credentials ? [{ action: "create", type: "admin", name: i.credentials.email }] : []),
    { action: "check", type: "http", name: "/login answers 200" },
  ];
}

export function buildPlan(i: Inspection): PlanItem[] {
  return [...configItems(i), ...resourceItems(i), ...releaseItems(i), ...finishItems(i)];
}

const MARK: Record<string, string> = { create: "+", write: "~" };

/** The short list shown before asking, in the style of the approved preview. */
export function renderPlan(plan: readonly PlanItem[], s: StyleSet): string[] {
  const listed = plan.filter((p) => ["worker", "d1", "r2", "lifecycle-rule", "config"].includes(p.type) && p.action !== "build" && p.action !== "deploy");
  const rows = listed.map((p) => `   ${s.green(MARK[p.action] ?? "·")} ${padVisual(p.type === "lifecycle-rule" ? "rule" : p.type, 8)}${p.name}`);
  const secrets = plan.filter((p) => p.type === "secret").length;
  const migrations = plan.filter((p) => p.type === "migrations").map((p) => Number(/: (\d+)/.exec(p.name)?.[1] ?? 0)).reduce((a, b) => a + b, 0);
  const upload = plan.some((p) => p.action === "upload");
  const steps = [
    "build",
    upload ? "upload (not live)" : "first upload",
    migrations > 0 ? plural(migrations, "migration") : "no migrations",
    ...(upload ? ["go live"] : []),
    ...(secrets > 0 ? [plural(secrets, "secret")] : []),
    ...(plan.some((p) => p.type === "admin") ? ["first admin"] : []),
    "check /login",
  ];
  return ["   Plan", ...rows, `   ${s.dim("→")} ${steps.join(", ")}`];
}
