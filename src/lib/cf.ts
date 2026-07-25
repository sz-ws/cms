import { getCloudflareContext } from "@opennextjs/cloudflare";

export function getEnv(): CloudflareEnv {
  return getCloudflareContext().env;
}
export const getDB = () => getEnv().DB;        // D1Database
export const getStorage = () => getEnv().STORAGE; // R2Bucket

// docs/spec-ai-capability.md:Workers AI binding。刻意不進 wrangler.jsonc(spec 明定
// 由使用者自行加,執行期偵測)——CloudflareEnv 型別因此未宣告 AI,與 settings.ts
// 讀 SECRETS_KEY 同款 unknown cast。缺 binding 回 undefined,呼叫端(CoreAiProvider)
// 當 not_configured 處理,絕不 throw。
export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
export const getAI = (): WorkersAiBinding | undefined =>
  (getEnv() as unknown as { AI?: WorkersAiBinding }).AI;

// Cloudflare Images binding(圖片變體轉換)。wrangler.jsonc 有宣告,型別因此是
// 必填的 ImagesBinding —— 但**執行期未必在**:帳號沒開通 Cloudflare Images 時
// 這個欄位會是 undefined。所以這裡刻意回 `| undefined`,逼呼叫端寫降級分支
// (見 src/app/api/files/[[...key]]/route.ts:轉不動就送原圖,不 404)。
export const getImages = (): ImagesBinding | undefined =>
  (getEnv() as unknown as { IMAGES?: ImagesBinding }).IMAGES;
