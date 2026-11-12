// 拆分輸出的指紋:拆分時記下輸入檔(OpenNext 的 server handler 與 worker.js)的 sha256,
// 之後比對現在的建置,認出「重新 build 了卻沒有重新拆分」的舊輸出。
//
// 為什麼需要:.open-next/split/ 只有拆分腳本會刪。選用拆分的站如果跑了 opennextjs-cloudflare build
// 卻跳過拆分,wrangler 會把上一次 build 的 server 模組,配上這一次 build 的 middleware 與靜態檔一起
// 上傳。指紋讓開機檢查與部署前的 `--check` 擋下這種組合。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const FINGERPRINT_FILE = "fingerprint.json";

/** 兩個輸入檔內容的指紋。 */
export function fingerprintOf(handlerBytes, workerBytes) {
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return { handler: hash(handlerBytes), worker: hash(workerBytes) };
}

/** 現在這份 .open-next/ 建置的指紋。 */
export function currentFingerprint(openNextDir) {
  return fingerprintOf(
    readFileSync(path.join(openNextDir, "server-functions", "default", "handler.mjs")),
    readFileSync(path.join(openNextDir, "worker.js")),
  );
}

/**
 * 拆分輸出跟現在的建置對不對得上。對得上回傳 null,否則回傳說明。
 * @param {string} openNextDir `.open-next/`
 */
export function fingerprintProblem(openNextDir) {
  const splitDir = path.join(openNextDir, "split");
  const file = path.join(splitDir, FINGERPRINT_FILE);
  if (!existsSync(file)) {
    return ".open-next/split/ 沒有拆分輸出(或沒有指紋)。先跑 node scripts/split-server-chunks.mjs。";
  }
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return `.open-next/split/${FINGERPRINT_FILE} 讀不懂:${error.message}`;
  }
  let current;
  try {
    current = currentFingerprint(openNextDir);
  } catch (error) {
    return `讀不到這一次 build 的輸出:${error.message}`;
  }
  if (recorded.handler !== current.handler || recorded.worker !== current.worker) {
    return (
      ".open-next/split/ 是上一次 build 拆出來的,跟現在的 .open-next/ 對不上:build 之後沒有重新拆分。" +
      "先跑 node scripts/split-server-chunks.mjs。"
    );
  }
  return null;
}
