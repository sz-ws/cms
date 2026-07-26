// Registry 讀取 —— 獨立小版,不 import cms core(避免拖 next/navigation 鏈)。
// 演算法對齊 src/lib/registry-client.ts:多源平行、size cap、同 host redirect、
// 逾時重試。支援 file://(本機測試)+ http(s)。private repo 用 token(Authorization: token <t>)。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_SOURCE =
  "https://raw.githubusercontent.com/sz-ws/registry/main";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 1024 * 1024; // 1 MB / 檔(code extension files/ 通常 KB 級)
const MAX_REDIRECTS = 3;

export interface IndexEntry {
  id: string;
  kind: "declarative" | "code";
  name: string;
  version: string;
  coreApi: string;
  /** 選填:若 registry index 提供 files 白名單,直接用它(權威);否則走啟發式猜檔名。 */
  files?: string[];
  /** 標記此 entry 來自哪個 source(多源衝突時列印用)。 */
  source: string;
}

export interface SourceConfig {
  url: string;
  token?: string;
}

export interface SourceFetchError {
  source: string;
  error: string;
  /** http 狀態碼(若適用);401 用於指路訊息。 */
  status?: number;
}

export interface IndexResult {
  entries: IndexEntry[];
  errors: SourceFetchError[];
}

export class RegistryFetchError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "RegistryFetchError";
    this.status = status;
  }
}

function isRetryable(e: unknown): boolean {
  // 逾時(AbortError)或 network error → 值得重試一次(spec:timeout 重試 1 次)。
  if (e instanceof RegistryFetchError) return e.status === undefined;
  return true;
}

async function followRedirects(
  url: string,
  token: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `token ${token}`;
  const originHost = new URL(url).host;
  let current = url;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetch(current, { signal, redirect: "manual", headers });
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get("location");
    await res.body?.cancel();
    res = null;
    if (!location) throw new RegistryFetchError("redirect is missing a location header");
    const next = new URL(location, current);
    if (next.protocol !== "https:" || next.host !== originHost) {
      throw new RegistryFetchError(`refusing cross-site redirect: ${next.host}`);
    }
    current = next.toString();
  }
  if (!res) throw new RegistryFetchError("too many redirects");
  if (!res.ok) throw new RegistryFetchError(`HTTP ${res.status}`, res.status);
  return res;
}

async function readBounded(res: Response): Promise<string> {
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BYTES) {
    throw new RegistryFetchError("response too large (exceeds 1 MB limit)");
  }
  if (!res.body) {
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new RegistryFetchError("response too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new RegistryFetchError("response too large (exceeds 1 MB limit)");
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function fetchHttpOnce(url: string, token?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await followRedirects(url, token, controller.signal);
    return await readBounded(res);
  } catch (e) {
    if (e instanceof RegistryFetchError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new RegistryFetchError("request timeout");
    }
    throw new RegistryFetchError(
      e instanceof Error ? e.message : "network error",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 單檔文字抓取。file:// 直讀磁碟;http(s) 帶 redirect/size cap,逾時/網路錯誤重試一次。 */
export async function fetchText(url: string, token?: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new RegistryFetchError(`invalid URL: ${url}`);
  }

  if (u.protocol === "file:") {
    try {
      const buf = await readFile(fileURLToPath(u));
      if (buf.byteLength > MAX_BYTES) throw new RegistryFetchError("response too large");
      return buf.toString("utf8");
    } catch (e) {
      if (e instanceof RegistryFetchError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new RegistryFetchError("not found", 404);
      throw new RegistryFetchError(
        e instanceof Error ? e.message : "failed to read file",
      );
    }
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new RegistryFetchError(`unsupported source protocol: ${u.protocol}`);
  }

  try {
    return await fetchHttpOnce(url, token);
  } catch (e) {
    if (isRetryable(e)) {
      return await fetchHttpOnce(url, token);
    }
    throw e;
  }
}

// registry.json 路徑變體(對齊 registry-client:支援不同 Git 服務的 raw 格式)。
const INDEX_PATH_VARIANTS = [
  "/registry.json",
  "/-/raw/main/registry.json",
  "/raw/main/registry.json",
];

interface RawEntry {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  version?: unknown;
  coreApi?: unknown;
  files?: unknown;
}

function parseIndex(json: unknown, source: string): IndexEntry[] {
  if (typeof json !== "object" || json === null) return [];
  const list = (json as { extensions?: unknown }).extensions;
  if (!Array.isArray(list)) return [];
  const out: IndexEntry[] = [];
  for (const raw of list as RawEntry[]) {
    if (
      typeof raw?.id === "string" &&
      (raw.kind === "declarative" || raw.kind === "code") &&
      typeof raw.name === "string" &&
      typeof raw.version === "string" &&
      typeof raw.coreApi === "string"
    ) {
      out.push({
        id: raw.id,
        kind: raw.kind,
        name: raw.name,
        version: raw.version,
        coreApi: raw.coreApi,
        files: Array.isArray(raw.files)
          ? raw.files.filter((f): f is string => typeof f === "string")
          : undefined,
        source,
      });
    }
  }
  return out;
}

/** 多源平行抓 registry.json;單源失敗只記錄,不中斷其他源。 */
export async function fetchIndex(sources: SourceConfig[]): Promise<IndexResult> {
  const entries: IndexEntry[] = [];
  const errors: SourceFetchError[] = [];

  await Promise.all(
    sources.map(async ({ url, token }) => {
      let text: string | null = null;
      let lastError: RegistryFetchError | null = null;
      for (const variant of INDEX_PATH_VARIANTS) {
        try {
          text = await fetchText(`${url}${variant}`, token);
          break;
        } catch (e) {
          lastError =
            e instanceof RegistryFetchError
              ? e
              : new RegistryFetchError(String(e));
        }
      }
      if (text === null) {
        errors.push({
          source: url,
          error: lastError?.message ?? "failed to fetch registry.json",
          status: lastError?.status,
        });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        errors.push({ source: url, error: "registry.json is not valid JSON" });
        return;
      }
      entries.push(...parseIndex(json, url));
    }),
  );

  return { entries, errors };
}
