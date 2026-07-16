import { getSetting } from "@/lib/settings";
import { putFile, deleteFile } from "@/lib/storage";
import type { Capability, UploadProvider } from "./capabilities";
import type { HookBus } from "./hooks";
import { CoreContentProvider } from "./dx/content-provider";
import { DemoCallbackProvider } from "./providers/demo-callback";
import { ResendEmailProvider } from "./providers/email";
import { CoreAiProvider } from "./providers/ai";
import type { Extension } from "./types";
import type { CoreServices } from "./services";

// core-v2 §2.2:ProviderRegistry。
//
// 設計決策(spec §2.2 要求說明):active provider 由 setting
// `core.provider.<capability>` 決定,讀 setting 為 async。若讓 get() 每次都讀 setting,
// 會把非同步性擴散到所有呼叫端。改為:在 services 建立時(每 request 一次)呼叫
// resolveActive() 預先解析各 capability 的 active id 並快取於 registry,之後 get() 保持
// 同步。fallback = 註冊時 id 為 "core" 的 provider。

const FALLBACK_ID = "core";

interface Entry {
  id: string;
  impl: unknown;
}

export interface ProviderRegistry {
  register(capability: Capability, id: string, impl: unknown): void;
  get<T>(capability: Capability): T; // active provider(無 → throw)
  // core-v2 §2.5:依 (capability, id) 精確查 —— callback 指向 URL 內指定的 providerId,
  // 未必是 active provider。找不到 → null(呼叫端據此回 404,不揭露原因)。
  getById<T>(capability: Capability, id: string): T | null;
  list(capability: Capability): { id: string }[];
}

export class ProviderRegistryImpl implements ProviderRegistry {
  private readonly byCapability = new Map<Capability, Entry[]>();
  private readonly activeId = new Map<Capability, string>();

  register(capability: Capability, id: string, impl: unknown): void {
    const list = this.byCapability.get(capability) ?? [];
    if (list.some((e) => e.id === id)) {
      throw new Error(
        `[providers] duplicate provider id "${id}" for capability "${capability}"`,
      );
    }
    // 不可變更新:push 到新陣列。
    this.byCapability.set(capability, [...list, { id, impl }]);
  }

  /**
   * 對每個已註冊 capability,讀 `core.provider.<capability>` 決定 active id;
   * 缺值或指向未註冊 id → 退回 FALLBACK_ID("core")。每 request 呼叫一次。
   */
  async resolveActive(): Promise<void> {
    for (const [capability, entries] of this.byCapability) {
      const configured = await getSetting<string>(
        `core.provider.${capability}`,
      );
      const chosen =
        configured && entries.some((e) => e.id === configured)
          ? configured
          : FALLBACK_ID;
      this.activeId.set(capability, chosen);
    }
  }

  get<T>(capability: Capability): T {
    const entries = this.byCapability.get(capability);
    if (!entries || entries.length === 0) {
      throw new Error(`[providers] no provider for capability "${capability}"`);
    }
    const id = this.activeId.get(capability) ?? FALLBACK_ID;
    const entry =
      entries.find((e) => e.id === id) ??
      entries.find((e) => e.id === FALLBACK_ID);
    if (!entry) {
      throw new Error(
        `[providers] no active provider for capability "${capability}" (active="${id}")`,
      );
    }
    return entry.impl as T;
  }

  // core-v2 §2.5:精確 id 查找。回傳該 id 的 impl,或 null(無此 capability / 無此 id)。
  getById<T>(capability: Capability, id: string): T | null {
    const entry = this.byCapability.get(capability)?.find((e) => e.id === id);
    return entry ? (entry.impl as T) : null;
  }

  list(capability: Capability): { id: string }[] {
    return (this.byCapability.get(capability) ?? []).map((e) => ({ id: e.id }));
  }

  /** 已有註冊者的 capability 全集(manifest requires[] 的滿足判定用)。 */
  capabilities(): string[] {
    return [...this.byCapability.keys()];
  }
}

// ---- core 預設 provider:upload(包 src/lib/storage.ts)----
// core-v2 §2.3:default impl "core"。url() 預設 `/api/files/${key}`。
const coreUploadProvider: UploadProvider = {
  put: (scope, filename, body, contentType) =>
    putFile(scope, filename, body, contentType),
  delete: (key) => deleteFile(key),
  url: (key) => `/api/files/${key}`,
};

/**
 * 建立一個帶 core 預設 provider 的 registry。core 在 extension 之前註冊自身預設。
 * content provider 需要 HookBus(觸發 content:* hooks),由呼叫端(services)注入。
 * (code extension 的 `provides` 註冊之後會加在此基礎上。)
 */
export function createRegistry(hooks: HookBus): ProviderRegistryImpl {
  const reg = new ProviderRegistryImpl();
  reg.register("upload", FALLBACK_ID, coreUploadProvider);
  // core-v2 §2.4:default ContentProvider("core")over the contents table。
  reg.register("content", FALLBACK_ID, new CoreContentProvider(hooks));
  // core-v2 §2.5 DEMO ONLY:證明 callback ingress 端到端可運作的範例 provider。
  // 真實 payment/extraction/OAuth provider 以相同方式註冊 —— 移除 demo 時刪此行。
  reg.register("demo-callback", "echo", new DemoCallbackProvider(hooks));
  // email:send 內建 provider(Resend HTTP)。id 用 "core" 走 get() 的 fallback
  // 慣例(同 upload/content);extension 的 SMTP 等 provider 以自己的 id 註冊,
  // 使用者以 core.provider.email:send 切換。
  reg.register("email:send", FALLBACK_ID, new ResendEmailProvider());
  // ai:generate 內建 provider(docs/spec-ai-capability.md):設定驅動路由
  // openai-compatible / anthropic-compatible / Workers AI 三模式。同 email:send,
  // 註冊≠已設定 —— mode:off 或缺 model/key 時 generate() 回 not_configured。
  reg.register("ai:generate", FALLBACK_ID, new CoreAiProvider());
  return reg;
}

/**
 * core-v2 §2.2:把 enabled code extension 的 `provides` 註冊進 reg —— 這是
 * `Extension.provides` 型別存在卻長期零 consumer 的補洞(78eac1b)。
 *
 * 每個 provider 的 `create(services)` 收到 **綁定至該 provider 自身 extension id**
 * 的 scoped CoreServices(storage/settings 綁自己的 extId),由呼叫端注入的
 * `makeServices` 工廠提供。chicken-egg 由呼叫端以兩段式化解:先 createRegistry() 建
 * reg + core 內建 → 再以指向 **同一** reg 實例的 services 跑本函式;create() 僅
 * 儲存 services、不在建構期 resolve provider,故晚註冊對同一實例可見。
 *
 * 重複 (capability, id) 由 reg.register() throw —— 照既有 fail-loud 語意,不吞。
 * disabled extension 不得出現在 `enabled`(由 loader 過濾),故其 provides 永不註冊。
 */
export function registerExtensionProviders(
  reg: ProviderRegistryImpl,
  enabled: readonly Extension[],
  makeServices: (extId: string) => CoreServices,
): void {
  for (const ext of enabled) {
    for (const p of ext.provides ?? []) {
      reg.register(p.capability, p.id, p.create(makeServices(ext.id)));
    }
  }
}
