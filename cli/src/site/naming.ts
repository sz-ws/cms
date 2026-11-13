// A site's name decides every resource name: Worker cms-<name>, D1 cms-<name>-db,
// R2 cms-<name>-storage and cms-<name>-next-cache. A fresh template still carries
// the shared names (cms, cms-db, ...); those are never deployed, because two sites
// on one account would share a database. Names are never guessed from what the
// account holds: a site is "configured" only when every name in wrangler.jsonc
// matches its vars.CMS_SITE_SLUG.

import { readWranglerConfig, type SiteResources, type WranglerConfig } from "../wrangler-config.js";

/** R2 names are at most 63 characters; cms-<name>-next-cache leaves 48 for the name. */
export const SITE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

export function validateSiteName(name: string): string | null {
  return SITE_NAME_RE.test(name)
    ? null
    : "A site name is 3-48 characters: lowercase letters, digits and hyphens, not starting or ending with a hyphen.";
}

function d1Names(base: string, separateTagCache: boolean): readonly [string, string] {
  return separateTagCache ? [`${base}-db`, `${base}-tag-cache`] : [`${base}-db`, `${base}-db`];
}

/**
 * The names derived from a site name. New sites share one D1 between DB and the
 * OpenNext tag cache; a site set up earlier with a separate tag-cache database
 * keeps it (separateTagCache) and is still recognised as configured.
 */
export function resourcesForName(name: string, separateTagCache = false): SiteResources {
  const base = `cms-${name}`;
  return {
    siteSlug: name,
    workerName: base,
    selfReferenceService: base,
    d1Names: d1Names(base, separateTagCache),
    r2Names: [`${base}-storage`, `${base}-next-cache`],
  };
}

function stockNames(separateTagCache: boolean): SiteResources {
  return { siteSlug: "", workerName: "cms", selfReferenceService: "cms", d1Names: d1Names("cms", separateTagCache), r2Names: ["cms-storage", "cms-next-cache"] };
}

function matches(config: WranglerConfig, expected: SiteResources): boolean {
  return (
    config.siteSlug === expected.siteSlug &&
    config.workerName === expected.workerName &&
    config.selfReferenceService === expected.selfReferenceService &&
    config.d1.length === expected.d1Names.length &&
    config.r2.length === expected.r2Names.length &&
    config.d1.every((entry, i) => entry.databaseName === expected.d1Names[i]) &&
    config.r2.every((entry, i) => entry.bucketName === expected.r2Names[i])
  );
}

export type NamingState = "fresh" | "configured" | "unsafe";

export function namingState(config: WranglerConfig): NamingState {
  if (matches(config, stockNames(false)) || matches(config, stockNames(true))) return "fresh";
  const slug = config.siteSlug;
  if (slug && !validateSiteName(slug) && (matches(config, resourcesForName(slug)) || matches(config, resourcesForName(slug, true)))) {
    return "configured";
  }
  return "unsafe";
}

export function namingStateOf(text: string): NamingState {
  return namingState(readWranglerConfig(text));
}
