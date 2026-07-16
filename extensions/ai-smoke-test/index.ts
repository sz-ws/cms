import { defineExtension } from "@/ext/types";
import { AiSmokeTestAdminPage } from "./admin-page";
import { generateHandler } from "./route";
import { generateStreamHandler } from "./stream-route";

// 純測試用的最小 code extension —— 唯一目的是驗證 ai:generate capability
// 從「extension 真正該走的路」(ctx.services.providers.get<AiProvider>,不是
// core 呼叫端的 src/lib/ai.ts 捷徑)真的打得通。不上 registry,只在本機 registry.ts
// 掛一行就能測;想拆掉的話刪這個資料夾 + registry.ts 那一行即可,沒有任何
// migration/資料要清。

export const aiSmokeTest = defineExtension({
  id: "ai-smoke-test",
  name: "AI Smoke Test",
  version: "0.0.1",
  coreApi: "^1.0.0",
  description: "ai:generate capability 的最小驗證 extension(僅本機測試用)。",
  icon: "puzzle",
  adminPages: [
    {
      slug: "",
      title: "AI Smoke Test",
      component: AiSmokeTestAdminPage,
    },
  ],
  apiRoutes: [
    {
      method: "POST",
      path: "generate",
      handler: generateHandler,
    },
    {
      method: "POST",
      path: "generate-stream",
      handler: generateStreamHandler,
    },
  ],
});
