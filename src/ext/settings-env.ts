// extension 設定的 env 覆寫(CORE_API 1.27.0)。
//
// 刻意獨立成一個檔案而不是留在 services.ts:services 的相依鏈會拉進 ext/loader,
// 而 loader 會載入 extension 的 React 元件 → `next/navigation` → 在 workers 測試
// pool 裡整個載不起來。這裡是純函式 + 一個只碰 env/settings 的工廠,抽出來之後
// test/ext-settings-env.test.ts 可以直接測,不必把半個 app 拖進測試。

import { getEnv } from "@/lib/cf";
import { getSetting, setSettings } from "@/lib/settings";
import type { ScopedSettings } from "./services";

/** key 必須是 `ext.<extId>.<name>` 形狀且 name 非空;否則 throw。 */
function assertScopedKey(extId: string, key: string): void {
  const prefix = `ext.${extId}.`;
  if (!key.startsWith(prefix) || key.length <= prefix.length) {
    throw new Error(
      `[services] settings key "${key}" outside scope "${prefix}*"`,
    );
  }
}

/**
 * scoped setting key → 環境變數名。`ext.newebpay.hashKey` → `EXT_NEWEBPAY_HASH_KEY`。
 *
 * ⚠️ **這個對應必須與 `cli/src/settings.ts` 的 `envKeyFor()` 逐字元一致。**
 * CLI 在 `add` 時用它決定寫哪個變數、在 `preflight` 時用它檢查有沒有設。兩邊算出
 * 不同的名字 = 寫入時叫 A、讀取時找 B,使用者會看到「設了卻沒生效」而且無從查起。
 * `test/ext-settings-env.test.ts` 用同一組例子把兩邊釘在一起。
 *
 * 為什麼加 extension 前綴:manifest 的 key 是 extension 內的區域名稱(`apiKey`),
 * 而 env 是整個 Worker 共用的**平坦命名空間** —— 直接用 key,兩個 extension 撞名
 * 時後裝的會靜默覆蓋先裝的。
 */
export function envKeyForSettingKey(extId: string, key: string): string {
  const field = key.slice(`ext.${extId}.`.length);
  const ext = extId.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  const name = field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
  return `EXT_${ext}_${name}`;
}

/**
 * 依 fallback 的型別把環境變數(恆為字串)轉成該 setting 宣告的型別。
 * 轉不動就當作沒設 —— 一個轉壞的值比沒有值更難查。
 */
function coerceEnvValue(raw: string, fallback: unknown): unknown | undefined {
  if (typeof fallback === "boolean") {
    const v = raw.trim().toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return undefined;
  }
  if (typeof fallback === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return raw;
}

/** 匯出供測試單獨取用:scopedServices 會急切建立 drizzle 實例,
 *  而 env 覆寫的行為與 db 無關,不該被那個相依拖住。 */
export function makeScopedSettings(extId: string): ScopedSettings {
  return {
    get: async (key, fallback) => {
      assertScopedKey(extId, key);
      // env 覆寫 D1(CORE_API 1.27.0)。順序是刻意的:12-factor 的慣例是環境
      // 覆寫設定檔,而且這是**唯一**能在首次 boot 前就配置好的途徑 —— D1 的
      // settings 表要 deploy 完才存在,CLI 在 install 當下碰不到它。
      //
      // 空字串視為未設,不是「設成空」。CLI 刻意不把 default 寫進 vars(那會產生
      // 「看起來設過、其實是佔位值」的欄位),這裡的判斷要與那個決定對齊。
      // getEnv() 在沒有 request context 時會 throw(build 期、非請求的 async
      // 情境都會踩到)。env 覆寫是**加分項**,拿不到就安靜退回 D1 —— 絕不能讓
      // 「讀不到環境」變成「設定整個讀不出來」。
      let raw: unknown;
      try {
        raw = (getEnv() as unknown as Record<string, unknown>)[
          envKeyForSettingKey(extId, key)
        ];
      } catch {
        raw = undefined;
      }
      if (typeof raw === "string" && raw.trim() !== "") {
        const coerced = coerceEnvValue(raw, fallback);
        if (coerced !== undefined) return coerced as never;
      }
      return getSetting(key, fallback);
    },
    set: (entries) => {
      for (const key of Object.keys(entries)) assertScopedKey(extId, key);
      return setSettings(entries);
    },
  };
}

