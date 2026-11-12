// [core] 2.0 草稿預覽(Next draft mode)要轉去的路徑:只收公開站裡的路徑。
// 單一 "/" 開頭,不是 "//"(協定相對網址)、不含反斜線(瀏覽器把 /\ 當成 //)與空白,
// 也不是後台、登入、首次設定、API —— 那些不是存起來的公開頁,不必預覽,也不該被當成跳板。

const NOT_PUBLIC = /^\/(admin|api|login|setup)(\/|$)/;

export function previewPath(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/[\s\\]/.test(raw)) return null;
  if (NOT_PUBLIC.test(raw)) return null;
  return raw;
}
