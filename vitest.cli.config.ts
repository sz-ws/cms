// CLI 測試專用 config —— 純 Node 環境,刻意不掛 @cloudflare/vitest-pool-workers。
// CLI 是純 Node 程式(node:fs / readline / process),塞進 workers pool 會炸 node API。
// 既有 `pnpm vitest run`(vitest.config.ts,workers pool)已排除 cli/**,兩者互不干擾。
// scripts/ 的建置腳本測試也在這裡:同樣是純 Node,而且要真的 import 產出的模組。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["cli/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },
});
