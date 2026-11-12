// workerd 在某個相容日期與旗標下原生提供哪些 Node 模組、wrangler 打包時會注入哪些全域。
//
// 取自 wrangler 自己打包時用的 @cloudflare/unenv-preset(從安裝的 wrangler 的位置解析,版本跟
// wrangler 綁在一起),不另外維護清單:preset 的 `external` 是原生提供、打包時保留 import 的模組;
// 其他 Node 模組在打包時換成 unenv 的版本。`inject` 裡值不是 false 的名字,打包時會被換成 import。
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SplitError } from "./ast.mjs";

/**
 * @param {string} root repo 根目錄(有 node_modules/wrangler)
 * @param {{ compatibility_date: string, compatibility_flags?: string[] }} config wrangler 設定
 */
export async function loadNodeCompat(root, config) {
  let preset;
  try {
    // pnpm 的 node_modules/wrangler 是連結;要從實際位置解析,才找得到 wrangler 自己的相依。
    const fromWrangler = createRequire(realpathSync(path.join(root, "node_modules", "wrangler", "package.json")));
    const pkg = fromWrangler.resolve("@cloudflare/unenv-preset/package.json");
    preset = await import(pathToFileURL(path.join(path.dirname(pkg), "dist", "index.mjs")).href);
  } catch (error) {
    throw new SplitError(`從安裝的 wrangler 找不到 @cloudflare/unenv-preset:${error.message}`);
  }
  if (typeof preset.getCloudflarePreset !== "function" || !Array.isArray(preset.nonPrefixedNodeModules)) {
    throw new SplitError("@cloudflare/unenv-preset 沒有預期的 getCloudflarePreset / nonPrefixedNodeModules。");
  }
  const result = preset.getCloudflarePreset({
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
  });
  if (!Array.isArray(result?.external) || typeof result?.inject !== "object") {
    throw new SplitError("@cloudflare/unenv-preset 回傳的設定沒有 external / inject。");
  }
  return {
    compatibilityDate: config.compatibility_date,
    nativeModules: new Set(result.external),
    nodeBuiltins: new Set(preset.nonPrefixedNodeModules),
    injectedGlobals: new Set(Object.entries(result.inject).filter(([, value]) => value !== false).map(([name]) => name)),
  };
}
