/**
 * 把一個 zod schema 的建立延到第一次用到,之後重用同一個實例。
 *
 * 為什麼:zod v4 每建一個節點(連 `.optional()`、`.refine()` 這類鏈式呼叫都會再建一個)
 * 都要跑一次類別初始化。大 schema 寫在模組頂層,等於每個冷的 isolate 一載入模組就先付這筆
 * CPU —— 不管這次請求用不用得到它(前台頁面從來不驗 manifest、不收這些 API 的 body)。
 *
 * 用法:`const fooSchema = lazySchema(() => z.object({ … }))`,用的地方寫 `fooSchema()`,
 * 型別寫 `z.infer<ReturnType<typeof fooSchema>>`。互相引用的 schema 一樣在 builder 裡呼叫
 * 對方的 accessor,所以同一個 isolate 裡每個 schema 仍然只有一個實例(z.toJSONSchema 抽
 * $defs、彼此共用節點都跟寫在頂層時相同)。
 */
export function lazySchema<T>(build: () => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= build());
}
