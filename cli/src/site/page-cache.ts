// The lifecycle rule on the page-cache bucket. Public pages are stored whole in
// the bucket bound as NEXT_INC_CACHE_R2_BUCKET under incremental-cache/<buildId>/;
// every deploy changes the build id and the previous pages are never read again.
// One rule deletes objects there 30 days after they were written.
//
// A rule the owner changed (another number of days, another name) is kept. A rule
// named expire-page-cache that does not delete old pages is reported, not changed.

import type { LifecycleRule } from "../cloudflare/port.js";

export const PAGE_CACHE_BINDING = "NEXT_INC_CACHE_R2_BUCKET";
export const PAGE_CACHE_PREFIX = "incremental-cache/";
export const PAGE_CACHE_RULE = "expire-page-cache";
export const PAGE_CACHE_EXPIRE_DAYS = 30;

export function pageCacheRuleToAdd(): LifecycleRule {
  return {
    id: PAGE_CACHE_RULE,
    enabled: true,
    conditions: { prefix: PAGE_CACHE_PREFIX },
    deleteObjectsTransition: { condition: { type: "Age", maxAge: PAGE_CACHE_EXPIRE_DAYS * 86_400 } },
  };
}

/** Why a rule does not delete old stored pages; empty when it does. */
export function ruleProblems(rule: LifecycleRule): string[] {
  const prefix = rule.conditions?.prefix ?? "";
  return [
    ...(rule.enabled ? [] : ["it is disabled"]),
    ...(PAGE_CACHE_PREFIX.startsWith(prefix) ? [] : [`its prefix is ${prefix}, not ${PAGE_CACHE_PREFIX}`]),
    ...(rule.deleteObjectsTransition ? [] : ["it does not delete objects"]),
  ];
}

export type PageCacheVerdict =
  | { kind: "present"; rule: LifecycleRule }
  | { kind: "add" }
  | { kind: "mismatch"; rule: LifecycleRule; problems: string[] };

export function pageCacheVerdict(rules: readonly LifecycleRule[]): PageCacheVerdict {
  const working = rules.filter((r) => ruleProblems(r).length === 0);
  const present = working.find((r) => r.id === PAGE_CACHE_RULE) ?? working[0];
  if (present) return { kind: "present", rule: present };
  const named = rules.find((r) => r.id === PAGE_CACHE_RULE);
  return named ? { kind: "mismatch", rule: named, problems: ruleProblems(named) } : { kind: "add" };
}
