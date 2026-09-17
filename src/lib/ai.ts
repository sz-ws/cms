import { getExtRuntime } from "@/ext/loader";
import { buildProviderRegistry } from "@/ext/services";
import type {
  AiChatOptions,
  AiChatResult,
  AiChatStreamEvent,
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
  AiStreamEvent,
} from "@/ext/providers/ai";

// core 呼叫端的 AI 呼叫入口(extension 端走 ctx.services.providers.get<AiProvider>
// ("ai:generate"),不經此檔)。跟 src/lib/email.ts 同一模式:每次建 registry(含
// extension provides)+ resolveActive,讓 core.provider.ai:generate 的切換
// (未來若有 extension 提供其他 AI provider)在這裡也生效。
//
// workers pool 地雷:本檔靜態 import loader/services 鏈沒關係(email.ts 同款)——
// 但被測試靜態 import 的呼叫端(如 /api/ai/generate route)不得把這條鏈拖進去,
// 該處須改為 handler 內 dynamic import(同 dx/notify.ts 慣例)。

async function activeAiProvider(): Promise<AiProvider> {
  const rt = await getExtRuntime();
  const registry = buildProviderRegistry(rt);
  await registry.resolveActive();
  return registry.get<AiProvider>("ai:generate");
}

/**
 * 1.39.0:admin 助理能不能用 —— 決定側欄入口與 /admin/agent 要不要開。
 * 需要 provider 已設定,而且支援 tool calling(chat 或 chatStream 其一);只會
 * generate 的第三方 provider 撐不起助理。任何例外一律當不可用:這是顯示判斷,
 * 不該讓整個 admin layout 因為設定讀取失敗而掛掉。
 */
export async function isAgentAvailable(): Promise<boolean> {
  try {
    const provider = await activeAiProvider();
    if (!provider.chat && !provider.chatStream) return false;
    return provider.isConfigured ? await provider.isConfigured() : true;
  } catch (e) {
    console.error("[ai] cannot resolve agent availability", e);
    return false;
  }
}

export async function generateAiText(
  opts: AiGenerateOptions,
): Promise<AiGenerateResult> {
  return (await activeAiProvider()).generate(opts);
}

// v1.1 streaming(見 docs/spec-ai-capability.md streaming 附錄)。同 generateAiText
// 走同一個 activeAiProvider() 解析路徑;若 resolve 出的 provider 沒實作
// generateStream(第三方 provider 也合法未實作),退回單一 error 事件,永不 throw
// ——與 generate() 的「設定不全 → not_configured」哲學一致。
export async function* generateAiTextStream(
  opts: AiGenerateOptions,
): AsyncGenerator<AiStreamEvent> {
  const provider = await activeAiProvider();
  if (!provider.generateStream) {
    yield { type: "error", error: "streaming_not_supported" };
    return;
  }
  yield* provider.generateStream(opts);
}

// v1.2 tool calling(見 docs/spec-admin-agent.md §3)。同樣走 activeAiProvider()
// 解析路徑;provider 沒實作 chat(第三方 provider 也合法未實作)就退
// tool_use_not_supported —— 與「未設定 → not_configured」「未實作 streaming →
// streaming_not_supported」同一個哲學:永不 throw,呼叫端一律看到 result。
export async function chatAiWithTools(
  opts: AiChatOptions,
): Promise<AiChatResult> {
  const provider = await activeAiProvider();
  if (!provider.chat) {
    return { ok: false, error: "tool_use_not_supported" };
  }
  return provider.chat(opts);
}

// v1.2.1 tool-calling streaming(1.32.0,見 docs/spec-admin-agent.md §3)。
//
// 與 generateAiTextStream 的差別在**退回方式**:那邊未實作就回一個
// streaming_not_supported 錯誤(呼叫端本來就是為串流而來的端點);這邊未實作則
// 退回呼叫一次非串流 chat(),把結果包成「只有一個 result 事件的 generator」——
// 因為串流在這裡是**顯示層的加值**,不是功能本身。呼叫端(agent loop)拿到的
// 一樣是一個 AiChatResult,少的只是逐字長出來的過程,不該因此看到錯誤。
//
// 兩層都不支援(連 chat 都沒有)才回 tool_use_not_supported —— 與 chatAiWithTools
// 同一個錯誤碼,面板的專屬提示因此在串流路徑上照樣成立。
export async function* chatAiStreamWithTools(
  opts: AiChatOptions,
): AsyncGenerator<AiChatStreamEvent> {
  const provider = await activeAiProvider();
  if (provider.chatStream) {
    yield* provider.chatStream(opts);
    return;
  }
  if (!provider.chat) {
    yield {
      type: "result",
      result: { ok: false, error: "tool_use_not_supported" },
    };
    return;
  }
  yield { type: "result", result: await provider.chat(opts) };
}
