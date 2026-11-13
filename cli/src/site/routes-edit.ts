// Custom domains in wrangler.jsonc: `routes` entries with `custom_domain: true`.
// Edits replace character ranges only (jsonc.ts), so comments and layout stay.

import { applyEdits, getMember, getStringMember, parseJsonc, skipTrivia, type JsoncNode } from "../jsonc.js";

export interface DeclaredRoute {
  pattern: string;
  customDomain: boolean;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Why `host` is not a domain this command accepts, or null. */
export function hostProblem(host: string): string | null {
  if (/^[a-z]+:\/\//i.test(host) || host.includes("/")) return `Give the host only (www.example.com), not a URL.`;
  if (!HOST_RE.test(host)) return `"${host}" is not a host name (lowercase, like www.example.com).`;
  if (host.endsWith(".workers.dev")) return "workers.dev addresses are not custom domains; they come with the Worker.";
  return null;
}

function routeOf(node: JsoncNode): DeclaredRoute | undefined {
  if (node.kind === "string") return { pattern: node.value, customDomain: false };
  const pattern = getStringMember(node, "pattern");
  if (!pattern) return undefined;
  const custom = getMember(node, "custom_domain")?.value;
  return { pattern, customDomain: custom?.kind === "boolean" && custom.value };
}

export function declaredRoutes(text: string): DeclaredRoute[] {
  const routes = getMember(parseJsonc(text), "routes")?.value;
  if (routes?.kind !== "array") return [];
  return routes.items.map(routeOf).filter((r): r is DeclaredRoute => r !== undefined);
}

function entry(host: string): string {
  return `{ "pattern": ${JSON.stringify(host)}, "custom_domain": true }`;
}

/** Add a custom domain; unchanged text when the host is already declared. */
export function addCustomDomain(text: string, host: string): string {
  const root = parseJsonc(text);
  const routes = getMember(root, "routes");
  if (!routes) {
    // After the Worker's name: a top-level member, before the comments of the next one.
    const anchor = getMember(root, "name") ?? getMember(root, "$schema");
    if (!anchor) return `${text.slice(0, root.span.start + 1)}\n  "routes": [${entry(host)}],${text.slice(root.span.start + 1)}`;
    const comma = commaAfter(text, anchor.value.span.end);
    return comma === null
      ? `${text.slice(0, anchor.value.span.end)},\n  "routes": [${entry(host)}]${text.slice(anchor.value.span.end)}`
      : `${text.slice(0, comma + 1)}\n  "routes": [${entry(host)}],${text.slice(comma + 1)}`;
  }
  if (routes.value.kind !== "array") throw new Error('"routes" in wrangler.jsonc is not an array');
  if (declaredRoutes(text).some((r) => r.pattern === host)) return text;
  const items = routes.value.items;
  if (items.length === 0) return applyEdits(text, [{ span: routes.value.span, replacement: `[${entry(host)}]` }]);
  const last = items[items.length - 1];
  return applyEdits(text, [{ span: { start: last.span.end, end: last.span.end }, replacement: `, ${entry(host)}` }]);
}

/** Remove the route whose pattern is `host`; unchanged text when there is none. */
export function removeRoute(text: string, host: string): string {
  const routes = getMember(parseJsonc(text), "routes")?.value;
  if (routes?.kind !== "array") return text;
  const index = routes.items.findIndex((n) => routeOf(n)?.pattern === host);
  if (index < 0) return text;
  const item = routes.items[index];
  const next = routes.items[index + 1];
  const previous = routes.items[index - 1];
  // Take the separating comma with it: up to the next item, or back to the previous one.
  const span = next ? { start: item.span.start, end: next.span.start } : previous ? { start: previous.span.end, end: item.span.end } : { start: routes.span.start, end: routes.span.end };
  return applyEdits(text, [{ span, replacement: next || previous ? "" : "[]" }]);
}

/** The position of the comma that follows a value, or null when it is the last member. */
function commaAfter(text: string, from: number): number | null {
  const i = skipTrivia(text, from);
  return text[i] === "," ? i : null;
}
