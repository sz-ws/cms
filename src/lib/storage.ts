import { nanoid } from "nanoid";
import { getStorage } from "./cf";
// 注意:loader 以動態 import 載入,避免 storage → loader → registry → posts/api →
// storage 的靜態循環相依(會造成 "Cannot access before initialization")。

// 06 §2:Storage 抽象層。所有檔案操作經此,extension 不直接碰 R2 binding。

export interface StoredFile {
  key: string;
  size: number;
  contentType: string;
}

/** 從原始檔名取小寫副檔名,僅允許 [a-z0-9]{1,8};否則回傳 "bin"。 */
function safeExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "bin";
  const ext = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
}

/** 產生 key:`<scope>/<yyyy>/<mm>/<nanoid>.<ext>`。 */
function makeKey(scope: string, filename: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${scope}/${yyyy}/${mm}/${nanoid()}.${safeExt(filename)}`;
}

export async function putFile(
  scope: string, // "core" 或 extId
  filename: string, // 原始檔名(只取副檔名)
  body: ReadableStream | ArrayBuffer | Blob,
  contentType: string,
): Promise<StoredFile> {
  const key = makeKey(scope, filename);
  const obj = await getStorage().put(key, body, {
    httpMetadata: { contentType },
  });
  const file: StoredFile = {
    key,
    size: obj?.size ?? 0,
    contentType,
  };
  // storage:uploaded hook(03 §1:({ key, size, contentType }))。
  // 動態 import 打破循環相依(見檔頭註解)。
  const { getExtRuntime } = await import("@/ext/loader");
  const rt = await getExtRuntime();
  await rt.hooks.doAction("storage:uploaded", file);
  return file;
}

export async function getFile(key: string): Promise<R2ObjectBody | null> {
  return (await getStorage().get(key)) ?? null;
}

export async function deleteFile(key: string): Promise<void> {
  await getStorage().delete(key);
}

export async function listFiles(
  prefix: string,
  cursor?: string,
): Promise<{ files: StoredFile[]; cursor?: string }> {
  // 注意:不帶 include 的話 R2 list 不回傳 contentType。
  const result = await getStorage().list({
    prefix,
    cursor,
    limit: 100,
    include: ["httpMetadata"],
  });
  const files: StoredFile[] = result.objects.map((o) => ({
    key: o.key,
    size: o.size,
    contentType: o.httpMetadata?.contentType ?? "application/octet-stream",
  }));
  return {
    files,
    cursor: result.truncated ? result.cursor : undefined,
  };
}
