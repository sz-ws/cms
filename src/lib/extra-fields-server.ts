import { getPlainSetting } from "@/lib/settings";
import {
  EXTRA_FIELDS_SETTING,
  parseExtraFieldsSetting,
  type ExtraFieldDef,
  type ExtraFieldsSetting,
} from "@/lib/extra-fields";

// 額外欄位的 server 端入口(規則見 lib/extra-fields.ts)。用 getPlainSetting:這個
// 設定不是 secret,而且 CRUD / 對外出口每次都讀,不值得為它多跑一次 secret 判定
// (那會去建整個 extension runtime)。

/** 全部內容類型的額外欄位定義(壞值當空,見 parseExtraFieldsSetting)。 */
async function getExtraFieldsSetting(): Promise<ExtraFieldsSetting> {
  return parseExtraFieldsSetting(await getPlainSetting<unknown>(EXTRA_FIELDS_SETTING));
}

/** 一種內容(完整 key "<extId>.<typeName>")的額外欄位定義;沒有就是空陣列。 */
export async function getExtraFieldDefs(type: string): Promise<ExtraFieldDef[]> {
  const all = await getExtraFieldsSetting();
  // 只認自己的 key:type 來自 webhook payload 這類外部形狀,"constructor" 之類的名字
  // 不能摸到原型鏈上。
  return Object.prototype.hasOwnProperty.call(all, type) ? all[type] : [];
}
