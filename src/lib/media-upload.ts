import type { CoreServices } from "@/ext/services";
import type { UploadProvider } from "@/ext/capabilities";
import type { StoredFile } from "./storage";

// 媒體庫的「存一個上傳的檔案」。後台上傳(/api/media/upload)與 AI 上傳
// (src/ext/agent-tools-media.ts 的 core.media.upload)走這**同一支**:同一個 key 規則
// (<scope>/<yyyy>/<mm>/<nanoid>.<ext>)、同一次尺寸嗅探與 alt metadata、同一個
// storage:uploaded hook、同一個網址規則。兩條路徑存出來的檔案在媒體庫裡分不出來。
//
// 變體不在這裡:/api/files 在送出時才縮放轉檔(image-variants.ts),R2 裡只有原檔。

/** 單一檔案上限。後台上傳與 AI 上傳共用(以前寫在 upload route 裡,同 posts 的上傳)。 */
export const MEDIA_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface SavedUpload extends StoredFile {
  /** 公開網址(啟用中的 UploadProvider 決定;內建的是 /api/files/<key>)。 */
  url: string;
}

export interface MediaUploadInput {
  /** 只取副檔名(見 storage.ts 的 makeKey)。 */
  filename: string;
  body: Blob;
  contentType: string;
  alt?: string;
}

/**
 * 經 services(scope 由呼叫端決定,後台與 AI 都是 "core")存一個檔案,回傳
 * StoredFile + url。大小上限由呼叫端在讀 body 之前就擋掉 —— 到這裡時 body 已經在記憶體裡。
 */
export async function saveMediaUpload(
  services: Pick<CoreServices, "storage" | "providers">,
  input: MediaUploadInput,
): Promise<SavedUpload> {
  const stored = await services.storage.put(
    input.filename,
    input.body,
    input.contentType,
    input.alt,
  );
  const url = services.providers.get<UploadProvider>("upload").url(stored.key);
  return { ...stored, url };
}
