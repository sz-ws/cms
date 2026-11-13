// Code plugins compiled into the site: the named imports in extensions/registry.ts,
// with the id and version each one declares in its index file. Text matching
// only — importing those files would pull the Next module graph into the CLI.

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PluginInfo {
  id: string;
  version: string | undefined;
}

const IMPORT_RE = /^\s*import\s*\{\s*\w+\s*\}\s*from\s*["']\.\/([A-Za-z0-9_-]+)["']/gm;

async function readFirst(files: readonly string[]): Promise<string | null> {
  for (const file of files) {
    try {
      return await readFile(file, "utf8");
    } catch {
      // try the next name
    }
  }
  return null;
}

/**
 * id and version from the object passed to defineExtension(). An id given as a
 * constant (not a string literal) falls back to the directory name.
 */
export function declared(source: string, dir: string): PluginInfo {
  const start = source.indexOf("defineExtension(");
  const body = start >= 0 ? source.slice(start) : source;
  const id = /\bid:\s*([^,\n]+)/.exec(body)?.[1].trim();
  const literal = id ? /^["']([^"']+)["']$/.exec(id)?.[1] : undefined;
  return { id: literal ?? dir, version: /\bversion:\s*["']([^"']+)["']/.exec(body)?.[1] };
}

export async function readPlugins(siteDir: string): Promise<PluginInfo[]> {
  const extDir = path.join(siteDir, "extensions");
  let registry: string;
  try {
    registry = await readFile(path.join(extDir, "registry.ts"), "utf8");
  } catch {
    return [];
  }
  const dirs = [...registry.matchAll(IMPORT_RE)].map((m) => m[1]);
  const plugins: PluginInfo[] = [];
  for (const dir of dirs) {
    const source = await readFirst(["index.ts", "index.tsx"].map((f) => path.join(extDir, dir, f)));
    plugins.push(source ? declared(source, dir) : { id: dir, version: undefined });
  }
  return plugins;
}
