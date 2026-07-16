import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { getSetting, setSettings } from "@/lib/settings";
import { putFile, deleteFile, listFiles } from "@/lib/storage";
import type { StoredFile } from "@/lib/storage";
import { extJobs } from "@/lib/schema";
import { getExtRuntime } from "./loader";
import type { ExtRuntime } from "./loader";
import { createRegistry, registerExtensionProviders } from "./providers";
import type { HookBus } from "./hooks";
import type { ProviderRegistry, ProviderRegistryImpl } from "./providers";

// core-v2 §2.1:CoreServices —— 傳給 extension API handler 的 ctx.services。
// storage/settings 皆 scope 綁定至 extId;providers active id 於此預先解析。

/** storage scope 綁定至 extId(§2.1)。 */
export interface ScopedStorage {
  put(
    filename: string,
    body: ReadableStream | ArrayBuffer | Blob,
    contentType: string,
  ): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  list(cursor?: string): Promise<{ files: StoredFile[]; cursor?: string }>;
}

/** settings 限定於 `ext.<extId>.*`;越界 throw(§2.1)。 */
export interface ScopedSettings {
  get<T = unknown>(key: string, fallback?: T): Promise<T>;
  set(entries: Record<string, unknown>): Promise<void>;
}

// spec-extension-jobs.md:jobs scope 綁定至 extId。schedule 的 jobId 必須是本
// extension `jobs[]` 宣告過的 handler,否則 throw;cancel 的 scope 檢查靠
// `WHERE id=? AND ext_id=<本 extId>`,越界靜默 0 列(不揭露他人 job 存在)。
export interface ScopedJobs {
  /** 排一次性任務。payload 以 JSON.stringify 存(undefined → NULL)。 */
  schedule(
    jobId: string,
    runAt: number,
    payload?: unknown,
  ): Promise<{ id: string }>;
  /** 取消尚未執行的一次性任務(dead 的也可清)。不存在或非本 extension 的 → no-op。 */
  cancel(id: string): Promise<void>;
}

export interface CoreServices {
  db: ReturnType<typeof db>; // drizzle 實例(v1 未 scope,v2.1 再議)
  storage: ScopedStorage;
  settings: ScopedSettings;
  hooks: HookBus;
  providers: ProviderRegistry;
  jobs: ScopedJobs;
}

/** key 必須是 `ext.<extId>.<name>` 形狀且 name 非空;否則 throw。 */
function assertScopedKey(extId: string, key: string): void {
  const prefix = `ext.${extId}.`;
  if (!key.startsWith(prefix) || key.length <= prefix.length) {
    throw new Error(
      `[services] settings key "${key}" outside scope "${prefix}*"`,
    );
  }
}

function makeScopedStorage(extId: string): ScopedStorage {
  return {
    put: (filename, body, contentType) =>
      putFile(extId, filename, body, contentType),
    // Phase E §7: delete must be scoped like put/list — without this check an
    // extension's ScopedStorage.delete could remove ANY key in R2 (other
    // extensions' files, core's files), not just its own.
    delete: (key) => {
      if (!key.startsWith(`${extId}/`)) {
        throw new Error(`storage.delete: key out of scope`);
      }
      return deleteFile(key);
    },
    // list 限定於本 ext 的 prefix(`<extId>/`)。
    list: (cursor) => listFiles(`${extId}/`, cursor),
  };
}

function makeScopedSettings(extId: string): ScopedSettings {
  return {
    get: (key, fallback) => {
      assertScopedKey(extId, key);
      return getSetting(key, fallback);
    },
    set: (entries) => {
      for (const key of Object.keys(entries)) assertScopedKey(extId, key);
      return setSettings(entries);
    },
  };
}

/**
 * jobs scope 綁定至 extId。schedule/cancel 是本身已是 async 的方法,故宣告驗證
 * 直接在方法內以既有(靜態 import 的)getExtRuntime() 查詢 —— 不需要把 rt 傳進
 * scopedServices 這個 sync 工廠本身(§services.jobs:「無 chicken-egg」)。
 */
function makeScopedJobs(extId: string): ScopedJobs {
  return {
    async schedule(jobId, runAt, payload) {
      if (!Number.isInteger(runAt) || runAt <= 0) {
        throw new Error(
          `[services] jobs.schedule: runAt must be a finite positive integer, got ${runAt}`,
        );
      }
      const rt = await getExtRuntime();
      const declared = rt.byId(extId)?.jobs?.some((j) => j.id === jobId) ?? false;
      if (!declared) {
        throw new Error(
          `[services] jobs.schedule: "${jobId}" is not a job declared by extension "${extId}"`,
        );
      }
      const id = crypto.randomUUID();
      await db()
        .insert(extJobs)
        .values({
          id,
          extId,
          jobId,
          kind: "once",
          runAt,
          payload: payload === undefined ? null : JSON.stringify(payload),
          attempts: 0,
          status: "pending",
          lastRun: null,
          lastError: null,
          createdAt: Date.now(),
        });
      return { id };
    },
    async cancel(id) {
      // 越界(非本 extension 的列)靜默 0 列,不揭露他人 job 是否存在。
      await db()
        .delete(extJobs)
        .where(and(eq(extJobs.id, id), eq(extJobs.extId, extId)));
    },
  };
}

/** 由既有零件組出 scope=extId 的 CoreServices(providers 由呼叫端注入,共享同一實例)。 */
export function scopedServices(
  extId: string,
  hooks: HookBus,
  providers: ProviderRegistry,
): CoreServices {
  return {
    db: db(),
    storage: makeScopedStorage(extId),
    settings: makeScopedSettings(extId),
    hooks,
    providers,
    jobs: makeScopedJobs(extId),
  };
}

/**
 * 建立「core 內建 + 所有 enabled code extension 的 provides」皆已註冊的 registry。
 * §2.2:這是所有 `createRegistry` 呼叫端(services / email / callback route /
 * service-requirements)共用的單一接線點,讓 extension 提供的 capability(如
 * cron:tick)在每個 registry 建立處一致可見。**不** resolveActive() —— 需要 active
 * 解析的呼叫端(createServices / email)自行於其後呼叫;callback route 用 getById、
 * service-requirements 用 capabilities(),皆不需要。
 *
 * 兩段式化解 chicken-egg:先 createRegistry() → 再對 **同一** reg 跑
 * registerExtensionProviders,每個 provider 的 create() 收到綁定其自身 extId、且
 * `.providers` 指向同一 reg 的 scoped services。
 */
export function buildProviderRegistry(rt: ExtRuntime): ProviderRegistryImpl {
  const reg = createRegistry(rt.hooks);
  registerExtensionProviders(reg, rt.enabled, (extId) =>
    scopedServices(extId, rt.hooks, reg),
  );
  return reg;
}

/**
 * 建立 scope=extId 的 CoreServices。每個 extension API request 呼叫一次。
 * providers registry 在此建立(含 extension provides)並解析 active id(§2.2)。
 */
export async function createServices(extId: string): Promise<CoreServices> {
  const rt = await getExtRuntime();
  const providers = buildProviderRegistry(rt);
  await providers.resolveActive();
  return scopedServices(extId, rt.hooks, providers);
}
