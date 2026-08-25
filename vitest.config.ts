// 測試棧:@cloudflare/vitest-pool-workers v0.18(vitest 4)。
// 用 dynamic import 載入 pool-workers(ESM-only);resolve.alias 讓 vitest 認得 `@/*`。
// d1Databases 接上 D1 binding —— binding-backed 整合測試(env.DB)靠它,證明 workerd + D1
// 真的跑(environment time > 0),不只是純邏輯。R2/secret 按需再擴。
import { defineConfig, configDefaults } from "vitest/config";
import path from "node:path";

export default defineConfig(async () => {
  const { cloudflareTest } = await import("@cloudflare/vitest-pool-workers");
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          // 必須固定(對齊 wrangler.jsonc):不設的話 pool 預設用「今天」,
          // 一旦超過安裝的 workerd binary 支援上限,整個 suite 會在某天
          // 無人改動的情況下自動起不來(ERR_RUNTIME_FAILURE)。
          // 必須與 wrangler.jsonc 一致,見該檔對這個日期的說明。
          compatibilityDate: "2026-07-01",
          // 必須與 wrangler.jsonc 的 compatibility_flags 一致 —— 不一致的話測試
          // 跑在一個「和正式站不同的 runtime」上。
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          bindings: {
            // 與 .dev.vars 同值(32-byte base64);供 AES-GCM secret 加密測試用。
            SECRETS_KEY: "GQ+clWLADtK1luUJYOxMfq6KBbzZL40jyjGQ3fYlwvY="  /* TEST-ONLY key, generated for public repo; never used anywhere real */,
          },
          d1Databases: {
            DB: "test-db",
            // migration-parity.test.ts 專用:DB 是跨測試檔共用的(各檔用
            // CREATE TABLE IF NOT EXISTS 鋪自己的最小鏡像),在上面從零套用
            // migrations/ 會撞名。獨立一顆才能證明「全新 D1 + 全部 migration」
            // 這條 fresh-install 路徑,不與任何其他檔案互相汙染。
            MIGRATIONS_DB: "migrations-test-db",
          },
        },
      }),
    ],
    resolve: {
      alias: { "@": path.resolve(process.cwd(), "src") },
    },
    // CLI 測試(cli/**)是純 Node,走 vitest.cli.config.ts;絕不進 workers pool。
    test: {
      exclude: [...configDefaults.exclude, "cli/**"],
    },
  };
});
