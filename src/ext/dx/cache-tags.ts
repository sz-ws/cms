// core-v2:public declarative content 的 cache tag 命名。純字串組合,不依賴 next/cache,
// 供讀取端(content-cache 的 unstable_cache tags)與 mutation 端(cache-invalidate 的
// revalidateTag)共用同一份命名規則,並可單獨單元測試(無 runtime 依賴)。
//
// tag 形狀:
//   content:<extId>.<typeName>  —— type-scoped(單一 content type 的所有 public 讀取)
//   ext:<extId>                 —— extension-scoped(該 extension 全部 content;install/
//                                  enable/disable 時整批失效)

/** 某 content type(完整 key "<extId>.<typeName>")的 type-scoped tag。 */
export function contentTag(type: string): string {
  return `content:${type}`;
}

/** 某 extension 的 ext-scoped tag。 */
export function extTag(extId: string): string {
  return `ext:${extId}`;
}

/** 從完整 type key("<extId>.<typeName>")取出 extId 段(首個 "." 之前)。
 * extId / typeName 皆不含 ".",故以首個 "." 切割即安全;無 "." 時整串即 extId。 */
export function extIdOfType(type: string): string {
  const dot = type.indexOf(".");
  return dot === -1 ? type : type.slice(0, dot);
}
