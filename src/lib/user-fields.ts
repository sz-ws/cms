// 會員自訂資料(1.81.0):插件記在「這個人」身上的東西,共用一張表(migrations/0026 的 user_fields)。
//
// 名稱一律是 `<插件 id>.<欄位>`。插件用 userFields(db, "<自己的 id>") 拿到只讀寫自己那一段的存取器,
// 傳進去、拿回來的都是欄位名稱(不帶前綴):
//   const fields = userFields(db, "members");
//   await fields.set(user.id, { phone: "0912…", region: "某縣" });
//   const { phone, region } = await fields.get(user.id, ["phone", "region"]);
// 值是 JSON(字串、數字、布林、物件),序列化後最多 4,000 字;set 給 null 或 undefined = 刪掉那一格,
// 沒存過的欄位不會出現在 get 的結果裡。刪掉使用者時整組跟著刪(外鍵 cascade);插件解除安裝時,core 刪掉
// 它那一段(src/ext/manager.ts 的 uninstallExtension),插件不用自己寫。
// 不是放密碼、金鑰的地方:這裡沒有加密(那些放 settings 的 secret,或插件自己加密)。
//
// 只用 D1 原生介面、沒有 `@/` 相依:插件的 engine 多半拿的是 D1Database。誰可以替誰寫(例如只存一般會員、
// 後台人員不存)是呼叫端的判斷,這裡只管存取。

const NAMESPACE_RE = /^[a-z][a-z0-9-]{0,40}$/;
const FIELD_RE = /^[a-z][a-zA-Z0-9_-]{0,60}$/;
/** 一個值序列化後的上限。 */
export const USER_FIELD_MAX_LENGTH = 4_000;
/** 一次讀寫最多幾個欄位。 */
const MAX_FIELDS = 50;

export interface UserFieldStore {
  /** 這幾個欄位存著的值(沒存過的不在結果裡;存的值解不開 JSON 也當作沒存過)。 */
  get(userId: string, fields: readonly string[]): Promise<Record<string, unknown>>;
  /** 寫入(一個 D1 batch);null / undefined = 刪掉那一格。使用者不存在時 throw(外鍵)。 */
  set(userId: string, values: Readonly<Record<string, unknown>>, now?: number): Promise<void>;
}

function checkedFields(names: readonly string[]): string[] {
  if (names.length > MAX_FIELDS) throw new Error(`[user-fields] at most ${MAX_FIELDS} fields at once`);
  for (const name of names) if (!FIELD_RE.test(name)) throw new Error(`[user-fields] invalid field name "${name}"`);
  return [...new Set(names)];
}

export function userFields(db: D1Database, namespace: string): UserFieldStore {
  if (!NAMESPACE_RE.test(namespace)) throw new Error(`[user-fields] invalid namespace "${namespace}"`);
  const prefix = `${namespace}.`;
  return {
    async get(userId, names) {
      const fields = checkedFields(names);
      if (!userId || fields.length === 0) return {};
      const rows = await db
        .prepare(`SELECT key, value FROM user_fields WHERE user_id = ? AND key IN (${fields.map(() => "?").join(", ")})`)
        .bind(userId, ...fields.map((f) => prefix + f))
        .all<{ key: string; value: string }>();
      const out: Record<string, unknown> = {};
      for (const row of rows.results) {
        try {
          out[row.key.slice(prefix.length)] = JSON.parse(row.value);
        } catch {
          // 壞掉的值當作沒存過。
        }
      }
      return out;
    },
    async set(userId, values, now = Date.now()) {
      const entries = Object.entries(values);
      checkedFields(entries.map(([name]) => name));
      if (!userId || entries.length === 0) return;
      const statements = entries.map(([name, value]) => {
        if (value === null || value === undefined) {
          return db.prepare("DELETE FROM user_fields WHERE user_id = ? AND key = ?").bind(userId, prefix + name);
        }
        const json = JSON.stringify(value);
        if (json === undefined || json.length > USER_FIELD_MAX_LENGTH) throw new Error(`[user-fields] value of "${name}" is not storable`);
        return db
          .prepare("INSERT INTO user_fields (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
          .bind(userId, prefix + name, json, now);
      });
      await db.batch(statements);
    },
  };
}
