import { headFile } from "@/lib/storage";
import type { DeclarativeField, DeclarativeLeafField } from "../manifest";
import { isMediaKey } from "../media-key";

// 公開 DetailView 的圖片原生尺寸查詢。
//
// 為什麼需要這一層:render 端手上只有一個 storage key(欄位值就是字串),尺寸
// 住在 R2 的 customMetadata。要在 <img> 上寫出 width/height 免 CLS,就得先問一次
// R2。這裡把「一頁會用到的所有 media key」收齊,一次平行 head 完,而不是每個
// <img> 各問一次。
//
// 成本:每張圖一次 R2 head(只讀 metadata,不計輸出流量),與 DetailView 既有的
// relation 解析同一批 await。detail 頁通常 1~3 張圖,可接受。
//
// 刻意**不**涵蓋 richtext 內嵌圖:那是使用者在編輯器裡插的任意張數,走同一套
// 會讓一篇長文變成數十次 head。內嵌圖靠 srcset 省頻寬,CLS 由編輯器版型的
// max-w-full 承擔 —— 收益/成本不成比例的那一半刻意留空,見 richtext-render.tsx。

export interface Dims {
  width: number;
  height: number;
}

/** key → 原生尺寸。查不到尺寸的 key 不會出現在 map 裡。 */
export type MediaDims = ReadonlyMap<string, Dims>;

/** 空 map 常數,省掉呼叫端到處寫 `new Map()`。 */
export const NO_MEDIA_DIMS: MediaDims = new Map();

/** 值是合法 media key 就收進 set。 */
function collectValue(value: unknown, out: Set<string>): void {
  if (typeof value !== "string" || value.length === 0) return;
  if (!isMediaKey(value)) return;
  out.add(value);
}

function collectLeaves(
  fields: readonly DeclarativeLeafField[],
  data: Record<string, unknown>,
  out: Set<string>,
): void {
  for (const f of fields) {
    if (f.type === "media") collectValue(data[f.key], out);
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asObjectArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter(
        (el): el is Record<string, unknown> =>
          el !== null && typeof el === "object" && !Array.isArray(el),
      )
    : [];
}

/**
 * 從欄位定義 + 一筆 entry 資料收集所有 media key。
 * 涵蓋頂層 media 欄與 group / repeater / blocks 的 leaf media 子欄
 * ——— 也就是 structural-render 會真的 render 出 <img> 的每一處。
 */
export function collectMediaKeys(
  fields: readonly DeclarativeField[],
  data: Record<string, unknown>,
): string[] {
  const out = new Set<string>();
  for (const f of fields) {
    if (f.type === "media") {
      collectValue(data[f.key], out);
      continue;
    }
    if (f.type === "group") {
      collectLeaves(f.fields ?? [], asObject(data[f.key]), out);
      continue;
    }
    if (f.type === "repeater") {
      for (const row of asObjectArray(data[f.key])) {
        collectLeaves(f.fields ?? [], row, out);
      }
      continue;
    }
    if (f.type === "blocks") {
      const byName = new Map((f.blocks ?? []).map((b) => [b.name, b]));
      for (const item of asObjectArray(data[f.key])) {
        const name = typeof item["block"] === "string" ? item["block"] : "";
        const def = byName.get(name);
        if (def) collectLeaves(def.fields, item, out);
      }
    }
  }
  return [...out];
}

/**
 * 平行查一組 key 的原生尺寸。
 *
 * 單一 key 查失敗(檔案被刪、R2 短暫錯誤)只是少了 width/height,不該讓整個
 * 公開頁掛掉 —— 所以每個查詢各自 catch,結果就是那個 key 不進 map。
 */
export async function loadMediaDims(keys: readonly string[]): Promise<MediaDims> {
  if (keys.length === 0) return NO_MEDIA_DIMS;
  const entries = await Promise.all(
    keys.map(async (key): Promise<[string, Dims] | null> => {
      try {
        const file = await headFile(key);
        if (!file || file.width === undefined || file.height === undefined) {
          return null;
        }
        return [key, { width: file.width, height: file.height }];
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((e): e is [string, Dims] => e !== null));
}
