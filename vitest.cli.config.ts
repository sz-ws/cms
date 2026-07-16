// CLI 測試專用 config —— 純 Node 環境,刻意不掛 @cloudflare/vitest-pool-workers。
// CLI 是純 Node 程式(node:fs / readline / process),塞進 workers pool 會炸 node API。
// 既有 `pnpm vitest run`(vitest.config.ts,workers pool)已排除 cli/**,兩者互不干擾。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["cli/**/*.test.ts"],
    environment: "node",
  },
});
