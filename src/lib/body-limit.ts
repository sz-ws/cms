// 有上限的 request body 讀取。
//
// 為什麼不能只看 Content-Length:那是**請求方寫的**。HTTP/1.1 的 chunked
// transfer 根本不帶這個 header,HTTP/2 也不強制,所以攻擊者只要不送它,
// 任何「先看 Content-Length 再 req.json()」的檢查就完全不存在 —— 而 req.json()
// 會把整個 body 收進 isolate 記憶體之後才回來。一個請求就能把 Worker 撐爆。
//
// 正確的作法只有一種:自己拿 reader,一邊累加一邊比對上限,超過就 cancel。
// Content-Length 仍然有用,但只當成「可以提早拒絕」的提示,不是防線。
//
// 這份邏輯原本只長在 callback route 裡(那裡另外還要保留 raw body 做簽章驗證),
// 其他公開入口(setup / login / passkey / declarative 的 public create)則各自
// 只檢查了 header。抽出來讓所有入口共用同一條防線。

/** 從 Content-Length 提早拒絕。回傳 true 代表可以直接回 413,不必開始讀。 */
export function declaredLengthExceeds(req: Request, maxBytes: number): boolean {
  const raw = req.headers.get("content-length");
  if (raw === null) return false;
  const declared = Number(raw);
  return Number.isFinite(declared) && declared > maxBytes;
}

/**
 * 讀完整個 body,但累計超過 maxBytes 就中止。
 *
 * @returns body 的位元組;`null` 代表過大(已 cancel,不會繼續吃記憶體)。
 */
export async function readBoundedBody(
  req: Request,
  maxBytes: number,
  logLabel: string,
): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel("payload_too_large");
        } catch (e) {
          // cancel 失敗不改變結果(照樣回 null),但要留痕 —— 它代表 runtime
          // 有異常,靜靜吞掉會讓之後的記憶體問題查不到源頭。
          console.error(`[${logLabel}] unable to cancel oversized request body`, e);
        }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** 同上,解碼成字串。callback 用這個保留 raw body 做簽章驗證。 */
export async function readBoundedText(
  req: Request,
  maxBytes: number,
  logLabel: string,
): Promise<string | null> {
  const bytes = await readBoundedBody(req, maxBytes, logLabel);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/**
 * 讀成 JSON 物件。回傳 discriminated union 而不是 throw,呼叫端才能直接
 * 把不同失敗對應到不同狀態碼(413 vs 400),不必解析錯誤型別。
 */
export type BoundedJson =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: "too_large" | "invalid" };

export async function readBoundedJsonObject(
  req: Request,
  maxBytes: number,
  logLabel: string,
): Promise<BoundedJson> {
  if (declaredLengthExceeds(req, maxBytes)) {
    return { ok: false, reason: "too_large" };
  }
  const text = await readBoundedText(req, maxBytes, logLabel);
  if (text === null) return { ok: false, reason: "too_large" };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
