import { getSetting, getRegistryTokenMap } from "./settings";
import { EXTENSION_ID_RE, isValidAssetFile } from "./registry-asset";
import type { ServiceRequirement } from "@/ext/service-requirements";

// core-v2 §3.4 / §5:registry client — 只信任 core.registrySources 白名單內的來源,
// https only、1 MB response cap、8s timeout、單一來源失敗不得中斷其他來源。

const DEFAULT_SOURCES = [
  "https://raw.githubusercontent.com/sz-ws/registry/main",
];

const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB cap（§5）

export interface RegistryIndexEntry {
  id: string;
  kind: "declarative" | "code";
  name: string;
  version: string;
  coreApi: string;
  description?: string;
  /** 顯示用作者名(registry.json 可寫 string 或 { name } 物件,解析時正規化)。 */
  author?: string;
  source: string; // 標記來源（configured registrySources 其中一個）
  icon?: string;
  iconUrl?: string;
  banner?: string;
  screenshots?: string[];
  // marketplace metadata(對應 manifest 的同名欄位;RegistryBrowser 消費)
  license?: string;
  tags?: string[];
  category?: string;
  deployment?: "instant" | "progressive" | "code-only";
  homepage?: string;
  repository?: string;
  supportUrl?: string;
  // roadmap #17:manifest.capabilities passthrough(RegistryBrowser 用 missingCapabilities
  // 客戶端算出哪些「這個 core 不支援」,disable 安裝按鈕 + 顯示標籤)。
  capabilities?: string[];
  /** manifest.requires passthrough(服務需求;RegistryBrowser 對照 index 回應的
   * services[] 判定 met/unmet)。 */
  requires?: ServiceRequirement[];
}

export interface SourceFetchError {
  source: string;
  error: string;
}

export interface RegistryIndexResult {
  entries: RegistryIndexEntry[];
  errors: SourceFetchError[];
}

export interface RegistrySourceConfig {
  url: string;
  token?: string;
}

/**
 * 讀取目前設定的 registry 來源清單（core.registrySources）。
 * Token 來自 core.registryTokens(secret,AES-GCM);registrySources 本體不存
 * token。過渡相容:更早版本把 token 明文塞在陣列項裡,在下次儲存前仍認得。
 */
export async function getRegistrySources(): Promise<RegistrySourceConfig[]> {
  const raw = await getSetting<unknown>("core.registrySources", DEFAULT_SOURCES);
  const tokenMap = await getRegistryTokenMap();
  const withToken = (config: RegistrySourceConfig): RegistrySourceConfig => ({
    ...config,
    token: tokenMap[config.url] ?? config.token,
  });

  // 相容舊格式：string[]
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    // 如果第一個元素是 string，代表是舊格式
    if (typeof raw[0] === "string") {
      return (raw as string[]).map((url) => withToken({ url }));
    }
    // 新格式：RegistrySourceConfig[]
    return (raw as RegistrySourceConfig[]).map(withToken);
  }

  return DEFAULT_SOURCES.map((url) => withToken({ url }));
}

/** https-only 基本檢查（SSRF 防線第一層；第二層是「必須完全等於白名單值」）。 */
function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

const MAX_REDIRECTS = 3;

/**
 * 帶 timeout + size cap 的 fetch，回傳原始文字（呼叫端自行 JSON.parse + try/catch）。
 * 任何失敗（逾時、非 2xx、超過大小上限、network error）一律 throw Error（可讀訊息）。
 *
 * Redirect 政策（SSRF 防線）:assertKnownRegistrySource 只驗證「設定的 base URL」,
 * 管不到 3xx 落地的 host,所以這裡用 redirect: "manual" 自己跟:每一跳必須是
 * https 且與原始 URL 同 host,最多 MAX_REDIRECTS 跳,違反即 throw。這樣既相容
 * Gitea raw URL 的同站轉址（/raw/branch/main → /raw/main）,又擋掉惡意 registry
 * 用 3xx 把請求導向內網/外站。Authorization header 只會送往同 host,不外洩。
 *
 * token: 可選的 Personal Access Token 或 Deploy Token，用於存取 private repository。
 * 格式：`token <token>`（Gitea / GitHub 皆支援）。
 */
/**
 * 共用的 redirect-chase 邏輯（見上方 boundedFetchText 文件的 SSRF 說明）：
 * 每一跳必須是 https 且與原始 URL 同 host，最多 MAX_REDIRECTS 跳，違反即
 * throw；回傳最終的 2xx Response（body 尚未讀取，由呼叫端依用途決定要以文字
 * 或 bytes 讀出並套用各自的 size cap）。
 */
async function followRedirects(
  url: string,
  token: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  const originHost = new URL(url).host;
  let current = url;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetch(current, {
      signal,
      redirect: "manual",
      headers,
    });
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get("location");
    await res.body?.cancel();
    res = null;
    if (!location) throw new Error("redirect without location header");
    const next = new URL(location, current);
    if (next.protocol !== "https:" || next.host !== originHost) {
      throw new Error(`cross-host redirect refused: ${next.host}`);
    }
    current = next.toString();
  }
  if (!res) throw new Error("too many redirects");
  if (!res.ok) {
    throw new Error(`http ${res.status}`);
  }
  return res;
}

async function boundedFetchText(url: string, token?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await followRedirects(url, token, controller.signal);
    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw new Error("response too large");
    }
    if (!res.body) {
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error("response too large");
      return text;
    }
    // 無 content-length 或不可信時，邊讀邊累計 byte 數，超過上限即中止。
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("response too large");
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
  } finally {
    clearTimeout(timer);
  }
}

const MAX_ASSET_BYTES = 4 * 1024 * 1024; // 4 MB cap for marketplace media（icon/banner/screenshots）

/**
 * boundedFetchText 的 binary 版本：同一組 redirect-chase + timeout，但以
 * Uint8Array 讀出（給圖片用，4 MB 上限）。回傳的 contentType 是 upstream
 * 回應原始 header，僅供參考——呼叫端（route）絕不可拿它當作真正的
 * Content-Type，一律改用檔名副檔名推導（見 registry-asset.ts）。
 * etag 同樣是 upstream 原始 header(可能為 null,不是每個來源都會附)——呼叫端
 * 只拿它做被動的 If-None-Match 快取比對用,不參與任何安全判斷。
 */
async function boundedFetchBytes(
  url: string,
  token: string | undefined,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string | null; etag: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await followRedirects(url, token, controller.signal);
    const contentType = res.headers.get("content-type");
    const etag = res.headers.get("etag");
    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new Error("response too large");
    }
    if (!res.body) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error("response too large");
      return { bytes, contentType, etag };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("response too large");
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
    return { bytes: combined, contentType, etag };
  } finally {
    clearTimeout(timer);
  }
}

interface RawIndexEntry {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  version?: unknown;
  coreApi?: unknown;
  description?: unknown;
  author?: unknown;
  icon?: unknown;
  iconUrl?: unknown;
  banner?: unknown;
  screenshots?: unknown;
  license?: unknown;
  tags?: unknown;
  category?: unknown;
  deployment?: unknown;
  homepage?: unknown;
  repository?: unknown;
  support?: unknown;
  capabilities?: unknown;
  requires?: unknown;
}

/** raw requires 陣列 → 正規化的 ServiceRequirement[](非法項直接丟棄)。 */
function parseRequires(raw: unknown): ServiceRequirement[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ServiceRequirement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as { capability?: unknown; optional?: unknown; reason?: unknown };
    if (typeof r.capability !== "string" || r.capability.length === 0) continue;
    out.push({
      capability: r.capability,
      optional: r.optional === true ? true : undefined,
      reason: typeof r.reason === "string" ? r.reason : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

const DEPLOYMENTS = ["instant", "progressive", "code-only"] as const;

function parseAuthor(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const name = (raw as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

function parseStringArray(raw: unknown): string[] | undefined {
  return Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : undefined;
}

function parseIndexEntries(json: unknown, source: string): RegistryIndexEntry[] {
  if (typeof json !== "object" || json === null) return [];
  const list = (json as { extensions?: unknown }).extensions;
  if (!Array.isArray(list)) return [];
  const out: RegistryIndexEntry[] = [];
  for (const raw of list as RawIndexEntry[]) {
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
        description:
          typeof raw.description === "string" ? raw.description : undefined,
        author: parseAuthor(raw.author),
        source,
        icon: typeof raw.icon === "string" ? raw.icon : undefined,
        iconUrl: typeof raw.iconUrl === "string" ? raw.iconUrl : undefined,
        banner: typeof raw.banner === "string" ? raw.banner : undefined,
        screenshots: parseStringArray(raw.screenshots),
        license: typeof raw.license === "string" ? raw.license : undefined,
        tags: parseStringArray(raw.tags),
        category: typeof raw.category === "string" ? raw.category : undefined,
        deployment: DEPLOYMENTS.includes(raw.deployment as never)
          ? (raw.deployment as (typeof DEPLOYMENTS)[number])
          : undefined,
        homepage: typeof raw.homepage === "string" ? raw.homepage : undefined,
        repository:
          typeof raw.repository === "string" ? raw.repository : undefined,
        supportUrl:
          raw.support && typeof raw.support === "object"
            ? typeof (raw.support as { url?: unknown }).url === "string"
              ? ((raw.support as { url: string }).url)
              : undefined
            : undefined,
        capabilities: parseStringArray(raw.capabilities),
        requires: parseRequires(raw.requires),
      });
    }
  }
  return out;
}

/**
 * core-v2 §3.4：GET /api/registry/index 的資料層。對每個 configured source 平行
 * fetch `<base>/registry.json`，merge 結果；單一來源失敗只記錄 error，不影響其他來源。
 */
export async function fetchRegistryIndex(): Promise<RegistryIndexResult> {
  const sourceConfigs = await getRegistrySources();
  const entries: RegistryIndexEntry[] = [];
  const errors: SourceFetchError[] = [];

  await Promise.all(
    sourceConfigs.map(async (config) => {
      const source = config.url;
      const token = config.token;

      try {
        if (!isHttpsUrl(source)) {
          throw new Error("source must be an https URL");
        }

        // 多路徑嘗試（支援不同 Git 服務的 raw URL 格式）
        const registryPathVariants = [
          `/registry.json`,
          `/-/raw/main/registry.json`,
          `/raw/main/registry.json`,
        ];

        let text: string | null = null;
        let lastError: Error | null = null;

        for (const variant of registryPathVariants) {
          try {
            const url = `${source}${variant}`;
            text = await boundedFetchText(url, token);
            break;
          } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
          }
        }

        if (!text) {
          throw lastError ?? new Error("failed to fetch registry.json");
        }

        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error("invalid JSON in registry.json");
        }
        entries.push(...parseIndexEntries(json, source));
      } catch (e) {
        errors.push({
          source,
          error: e instanceof Error ? e.message : "unknown error",
        });
      }
    }),
  );

  return { entries, errors };
}

export class UnknownRegistrySource extends Error {
  constructor(source: string) {
    super(`source not in configured core.registrySources: ${source}`);
  }
}

/**
 * core-v2 §3.4 / §5 SSRF 防線：source 必須「完全等於」目前設定的 registrySources 其中一個。
 * 絕不接受 request body 中任意 URL —— 只信任已設定的白名單值本身。
 */
export async function assertKnownRegistrySource(source: string): Promise<void> {
  const sources = await getRegistrySources();
  const urls = sources.map((s) => s.url);
  if (!urls.includes(source)) {
    throw new UnknownRegistrySource(source);
  }
}

/**
 * core-v2 §3.4：fetch `<base>/extensions/<id>/manifest.json`。
 * 呼叫端必須先以 assertKnownRegistrySource 驗證 source（此處僅重複 https 檢查作為 defense-in-depth）。
 * 回傳 parsed JSON（unknown）；呼叫端再交給 parseManifest 做 zod 驗證。
 */
// 與 manifest.ts 的 ID_RE 一致（extension id 規則）；避免 id 被用於 path traversal
// （如 "../../secret"）或注入額外路徑段。單一事實來源：registry-asset.ts。
const ID_RE = EXTENSION_ID_RE;

/**
 * 嘗試多種 Git 服務的 raw URL 格式，找到第一個能成功抓取 manifest.json 的路徑。
 * 支援：GitHub、Gitea、GitLab、Bitbucket 等常見格式。
 */
async function tryFetchManifest(source: string, id: string, token?: string): Promise<string> {
  if (!isHttpsUrl(source)) {
    throw new Error("source must be an https URL");
  }
  if (!ID_RE.test(id)) {
    throw new Error("invalid extension id");
  }

  // 常見的 raw URL 路徑格式（依序嘗試）
  const pathVariants = [
    `/extensions/${id}/manifest.json`,           // GitHub / Gitea / Bitbucket 標準格式
    `/-/raw/main/extensions/${id}/manifest.json`, // GitLab 格式
    `/raw/main/extensions/${id}/manifest.json`,   // 某些 Gitea / GitLab 變體
  ];

  let lastError: Error | null = null;

  for (const variant of pathVariants) {
    try {
      const url = `${source}${variant}`;
      const text = await boundedFetchText(url, token);
      return text;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // 繼續嘗試下一個路徑
    }
  }

  throw lastError ?? new Error(`failed to fetch manifest for ${id} from ${source}`);
}

export async function fetchManifest(source: string, id: string): Promise<unknown> {
  // 從已配置的來源中找出對應的 token（如果有）
  const sourceConfigs = await getRegistrySources();
  const config = sourceConfigs.find((c) => c.url === source);
  const token = config?.token;

  const text = await tryFetchManifest(source, id, token);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid JSON in manifest.json");
  }
}

// 檔名白名單:單一段檔名(a-z0-9 . _ -),不得含 "/" 或 ".."。呼叫端目前只以固定的
// "style.css"(manifest 是 z.literal)傳入,但此處再擋一次 path traversal 作為
// defense-in-depth —— 絕不讓 filename 帶額外路徑段或跳出 extensions/<id>/ 目錄。
const ASSET_FILENAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * core-v2 §3.4:fetch `<base>/extensions/<id>/<filename>` 的原始文字(非 JSON)。
 * 與 fetchManifest 共用同一組 raw-URL path variants + token + SSRF-guarded
 * boundedFetchText(https-only、size cap、timeout、同 host redirect)。
 *
 * 呼叫端必須先以 assertKnownRegistrySource 驗證 source(此處僅重複 https / id / filename
 * 檢查作為 defense-in-depth)。回傳原文;抓取失敗一律 throw Error(可讀訊息)。
 */
export async function fetchExtensionAsset(
  source: string,
  id: string,
  filename: string,
): Promise<string> {
  if (!isHttpsUrl(source)) {
    throw new Error("source must be an https URL");
  }
  if (!ID_RE.test(id)) {
    throw new Error("invalid extension id");
  }
  if (!ASSET_FILENAME_RE.test(filename) || filename.includes("..")) {
    throw new Error("invalid asset filename");
  }

  const sourceConfigs = await getRegistrySources();
  const config = sourceConfigs.find((c) => c.url === source);
  const token = config?.token;

  const pathVariants = [
    `/extensions/${id}/${filename}`, // GitHub / Gitea / Bitbucket 標準格式
    `/-/raw/main/extensions/${id}/${filename}`, // GitLab 格式
    `/raw/main/extensions/${id}/${filename}`, // 某些 Gitea / GitLab 變體
  ];

  let lastError: Error | null = null;
  for (const variant of pathVariants) {
    try {
      return await boundedFetchText(`${source}${variant}`, token);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`failed to fetch ${filename} for ${id} from ${source}`);
}

/**
 * core-v2:binary 版 fetchExtensionAsset,給 GET /api/registry/asset(marketplace
 * media proxy)用。同一組 raw-URL path variants + token 查找 + SSRF-guarded
 * redirect-chase(見 followRedirects),但走 boundedFetchBytes(4 MB cap，圖片
 * 用)而非 boundedFetchText。
 *
 * 呼叫端必須先以 assertKnownRegistrySource 驗證 source、再以
 * registry-asset.ts 的 isValidAssetFile 驗證 filename(此處用同一份規則重複
 * 檢查作為 defense-in-depth)。回傳的 contentType 是 upstream 原始 header，僅
 * 供除錯用——呼叫端絕不可信任它來決定 response 的 Content-Type，一律改用檔名
 * 副檔名推導。etag 亦是 upstream 原始 header(可能 null),供呼叫端做被動快取
 * 比對(HTTP Cache-Control / If-None-Match),不影響任何安全判斷。抓取失敗一律
 * throw Error(可讀訊息)。
 */
export async function fetchExtensionAssetBytes(
  source: string,
  id: string,
  filename: string,
): Promise<{ bytes: Uint8Array; contentType: string | null; etag: string | null }> {
  if (!isHttpsUrl(source)) {
    throw new Error("source must be an https URL");
  }
  if (!ID_RE.test(id)) {
    throw new Error("invalid extension id");
  }
  if (!isValidAssetFile(filename)) {
    throw new Error("invalid asset filename");
  }

  const sourceConfigs = await getRegistrySources();
  const config = sourceConfigs.find((c) => c.url === source);
  const token = config?.token;

  const pathVariants = [
    `/extensions/${id}/${filename}`, // GitHub / Gitea / Bitbucket 標準格式
    `/-/raw/main/extensions/${id}/${filename}`, // GitLab 格式
    `/raw/main/extensions/${id}/${filename}`, // 某些 Gitea / GitLab 變體
  ];

  let lastError: Error | null = null;
  for (const variant of pathVariants) {
    try {
      return await boundedFetchBytes(`${source}${variant}`, token, MAX_ASSET_BYTES);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`failed to fetch ${filename} for ${id} from ${source}`);
}
