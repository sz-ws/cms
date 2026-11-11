import { D1NextModeTagCache } from "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache";

// [core] 2.0 頁面快取的 tag 快取:OpenNext 的 D1 tag 快取(表 `revalidations`),出錯時多留一行好查的 log。
//
// 失效(publicContentChanged → revalidatePath)真正寫進 D1 是在回應送出之後(Next 的 pendingWaitUntil),
// 寫失敗時 OpenNext 只記一行沒有前因後果的錯誤,存起來的頁面就一直是舊的,直到下一次失效或部署。
// 讀失敗時 OpenNext 當作「沒有失效」,照樣回存起來的頁面(fail open:D1 出狀況時網站還在)。
// 兩種行為都不改,只在這裡記下「[page-cache] …」,讓 Workers Logs 查得到發生了什麼。
//
// 做法是 OpenNext 的 tagCache override(open-next.config.ts):沿用它的 D1NextModeTagCache,
// 只把它拿到的 D1 binding 包一層,失敗時記 log 再照原樣丟出去。不 import 錯誤回報(observe):
// 這段在 Worker 的前門,每個冷啟動都要編譯它。

export const TAG_WRITE_FAILED = "[page-cache] could not record an invalidation; stored public pages keep the old version until the next invalidation or deploy";
export const TAG_READ_FAILED = "[page-cache] could not read invalidations; serving the stored page as fresh";

type Logger = (message: string, error: unknown) => void;

/** 包過的 statement → 原本的 statement(batch 交給 D1 的一定是原本那個)。 */
const originals = new WeakMap<object, D1PreparedStatement>();

/** D1 binding 包一層:讀(raw)或寫(batch)失敗時記 log,錯誤照原樣丟出去。其餘原樣轉交。 */
export function loggingTagDb(db: D1Database, log: Logger = (m, e) => console.error(m, e)): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          try {
            return await target.batch(statements.map((s) => originals.get(s) ?? s));
          } catch (error) {
            log(TAG_WRITE_FAILED, error);
            throw error;
          }
        };
      }
      if (prop === "prepare") {
        return (sql: string) => loggingStatement(target.prepare(sql), log);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function loggingStatement(statement: D1PreparedStatement, log: Logger): D1PreparedStatement {
  const wrapped = new Proxy(statement, {
    get(target, prop) {
      if (prop === "bind") return (...values: unknown[]) => loggingStatement(target.bind(...values), log);
      if (prop === "raw") {
        return async (...args: unknown[]) => {
          try {
            return await (target.raw as (...a: unknown[]) => Promise<unknown>)(...args);
          } catch (error) {
            log(TAG_READ_FAILED, error);
            throw error;
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  originals.set(wrapped, statement);
  return wrapped;
}

// getConfig() 是 D1NextModeTagCache 拿 D1 binding 的地方(TypeScript 標成 private,JS 裡是一般方法)。
// 要繼承而不是包一層:它的查詢走 #private 方法,只有真的由這個 class 建出來的物件才能呼叫。
type TagCacheConfig = { isDisabled: true } | { isDisabled: false; db: D1Database };
const D1TagCacheBase = D1NextModeTagCache as unknown as new () => Omit<D1NextModeTagCache, "getConfig"> & {
  getConfig(): TagCacheConfig;
};

class LoggingD1TagCache extends D1TagCacheBase {
  override getConfig(): TagCacheConfig {
    const config = super.getConfig();
    return config.isDisabled ? config : { isDisabled: false, db: loggingTagDb(config.db) };
  }
}

export const pageCacheTagCache = new LoggingD1TagCache();
