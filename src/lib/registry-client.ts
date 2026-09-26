import { getSetting, getRegistryTokenMap } from "./settings";
import { EXTENSION_ID_RE, isValidAssetFile } from "./registry-asset";
import type { ServiceRequirement } from "@/ext/service-requirements";
import { isIdentity, type PluginRequirement } from "@/ext/plugin-ref";
import type { LocalizedString } from "@/lib/i18n/localized";
import {
  httpsUrl,
  parseAccess,
  parseIsoDate,
  parseOffer,
  type RegistryAccess,
  type RegistryOffer,
} from "./registry-offer";
import { REGISTRY_MESSAGE_MAX, sanitizeRegistryText } from "./registry-text";

// core-v2 §3.4 / §5:registry client — 只信任 core.registrySources 白名單內的來源,
// https only、1 MB response cap、8s timeout、單一來源失敗不得中斷其他來源。

const DEFAULT_SOURCES = [
  "https://raw.githubusercontent.com/sz-ws/registry/main",
];

const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB cap（§5）

export interface RegistryIndexEntry {
  id: string;
  /** 1.50.0:跨來源的全域名字(見 @/ext/plugin-ref)。格式不對就當作沒有。 */
  identity?: string;
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
  /** support.url(https 才收)。 */
  supportUrl?: string;
  /** support.email。商店的「聯絡提供者」沒有 supportUrl 時用它。 */
  supportEmail?: string;
  // roadmap #17:manifest.capabilities passthrough(RegistryBrowser 用 missingCapabilities
  // 客戶端算出哪些「這個 core 不支援」,disable 安裝按鈕 + 顯示標籤)。
  capabilities?: string[];
  /** manifest.requires passthrough(服務需求;RegistryBrowser 對照 index 回應的
   * services[] 判定 met/unmet)。 */
  requires?: ServiceRequirement[];
  /** 1.50.0:需要的其他插件。宣告式來自 manifest.requiresExtensions;程式碼插件的
   * registry.json 可以直接寫 Extension.requiresExtensions 的 id 陣列。 */
  requiresExtensions?: PluginRequirement[];
  /** 付費插件協定 1:閘道依金鑰加上的開通狀態。沒有 = 免費(或靜態 registry)。 */
  access?: RegistryAccess;
  /** 價格與說明。只有同時有 access 時才會有(見 parseIndexEntries)。 */
  offer?: RegistryOffer;
  /** 1.56.0:access 為 requested 時,閘道記下的申請日期(商店的「已申請 · 9/23」)。 */
  requestedAt?: string;
}

export interface SourceFetchError {
  source: string;
  error: string;
  /** registry 回的 http 狀態碼;401 / 403 = 金鑰不能用,商店據此換成白話。 */
  status?: number;
}

export interface RegistryIndexResult {
  entries: RegistryIndexEntry[];
  errors: SourceFetchError[];
}

export interface RegistrySourceConfig {
  url: string;
  token?: string;
  /** 1.48.0:這個來源的宣告式插件可以帶 manifest.scripts。預設不行。 */
  allowScripts?: boolean;
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

/**
 * 1.48.0:這個來源的插件能不能帶 scripts。只認明確設成 true 的來源 —— 管理員加一個
 * 來源時預設是「只信任它的資料」,要讓它能在前台跑程式得另外打開。
 */
export async function sourceAllowsScripts(source: string): Promise<boolean> {
  const sources = await getRegistrySources();
  return sources.some((s) => s.url === source && s.allowScripts === true);
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
 * 付費插件協定的版本,每個 registry 請求都帶(X-Registry-Protocol)。閘道看到它才列出
 * 未開通的付費插件、才回 402;沒帶的請求(舊 core、舊 CLI)照舊:不列、回 404 —— 舊 core
 * 因此不會看到一顆按下去才失敗的安裝鈕。
 */
const REGISTRY_PROTOCOL = "1";

/**
 * registry 回了非 2xx。除了 status,再帶上 body 裡的 `{ error, message }`(閘道的錯誤形狀):
 *   401 / 403 —— 金鑰本身不能用(沒帶、不認得、已撤銷),整個來源都讀不到
 *   402 not_entitled —— 這把金鑰沒開通這個插件,只影響這一個
 * detail 是消毒過、截到 200 字的 message;Error.message 維持 `http <status>`。
 */
export class RegistryHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
  constructor(status: number, code?: string, detail?: string) {
    super(`http ${status}`);
    this.name = "RegistryHttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const ERROR_BODY_MAX = 4 * 1024;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * 錯誤回應的 body 只讀前 4 KB,解析得出 `{ error, message }` 才用,否則當作沒有。
 * 1.56.0 起申請(sendAccessRequest)的成功回應 `{ message? }` 也走這裡。
 */
async function readErrorBody(res: Response): Promise<{ code?: string; detail?: string }> {
  try {
    let text: string;
    if (!res.body) {
      text = (await res.text()).slice(0, ERROR_BODY_MAX);
    } else {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < ERROR_BODY_MAX) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      await reader.cancel().catch(() => {});
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      text = new TextDecoder().decode(combined.slice(0, ERROR_BODY_MAX));
    }
    const body = JSON.parse(text) as { error?: unknown; message?: unknown } | null;
    const code = typeof body?.error === "string" && ERROR_CODE_RE.test(body.error) ? body.error : undefined;
    const detail =
      typeof body?.message === "string" ? sanitizeRegistryText(body.message, REGISTRY_MESSAGE_MAX) || undefined : undefined;
    return { code, detail };
  } catch {
    return {};
  }
}

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
  const headers: Record<string, string> = { "X-Registry-Protocol": REGISTRY_PROTOCOL };
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
    const { code, detail } = await readErrorBody(res);
    throw new RegistryHttpError(res.status, code, detail);
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

// 各種 Git 服務的 raw URL 格式:GitHub / Gitea / Bitbucket 標準格式、GitLab、某些 Gitea /
// GitLab 變體。依序試,成功的那一個按來源記下來(同一個 isolate 內),之後先試它。
const PATH_PREFIXES = ["", "/-/raw/main", "/raw/main"] as const;
const workingPrefix = new Map<string, string>();

/**
 * 在 `<source><前綴><path>` 的各種前綴上抓同一個檔。只有 404 代表「這個格式沒有這個檔」、
 * 換下一個試;其他回應(401 / 403 金鑰不能用、402 沒開通、5xx)就是答案,立刻丟出 ——
 * 繼續試下去的話,後面格式的 404 會蓋掉真正的原因(402 變成「找不到」)。網路錯誤、
 * 逾時沒有回應可看,照舊往下試。
 */
async function fetchFromVariants<T>(
  source: string,
  path: string,
  fetchOne: (url: string) => Promise<T>,
): Promise<T> {
  const known = workingPrefix.get(source);
  const prefixes = known === undefined ? PATH_PREFIXES : [known, ...PATH_PREFIXES.filter((p) => p !== known)];
  let lastError: Error | null = null;
  for (const prefix of prefixes) {
    try {
      const result = await fetchOne(`${source}${prefix}${path}`);
      workingPrefix.set(source, prefix);
      return result;
    } catch (e) {
      if (e instanceof RegistryHttpError && e.status !== 404) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`failed to fetch ${path} from ${source}`);
}

interface RawIndexEntry {
  id?: unknown;
  identity?: unknown;
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
  requiresExtensions?: unknown;
  access?: unknown;
  offer?: unknown;
  requestedAt?: unknown;
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

const REQUIRED_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

function parseLocalized(raw: unknown): LocalizedString | undefined {
  if (typeof raw === "string") return raw.slice(0, 200);
  if (!raw || typeof raw !== "object") return undefined;
  const { en, "zh-Hant": zh } = raw as { en?: unknown; "zh-Hant"?: unknown };
  const out: { en?: string; "zh-Hant"?: string } = {};
  if (typeof en === "string") out.en = en.slice(0, 200);
  if (typeof zh === "string") out["zh-Hant"] = zh.slice(0, 200);
  return out.en !== undefined || out["zh-Hant"] !== undefined ? out : undefined;
}

/**
 * raw requiresExtensions → PluginRequirement[]。程式碼插件的 registry.json 多半直接
 * 抄 Extension.requiresExtensions(字串陣列),宣告式的是物件陣列;兩種都收,非法項丟棄。
 */
function parseRequiredExtensions(raw: unknown): PluginRequirement[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PluginRequirement[] = [];
  for (const item of raw.slice(0, 20)) {
    const r = typeof item === "string" ? { id: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!r || typeof r.id !== "string" || !REQUIRED_ID_RE.test(r.id)) continue;
    if (out.some((existing) => existing.id === r.id)) continue;
    out.push({
      id: r.id,
      identity: isIdentity(r.identity) ? r.identity : undefined,
      optional: r.optional === true ? true : undefined,
      reason: parseLocalized(r.reason),
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

// 只收一般的商務信箱形狀;不收 ? & % 等字元,mailto: 連結就帶不進額外的標頭或內文。
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function parseEmail(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length <= 254 && EMAIL_RE.test(raw) ? raw : undefined;
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
      const support =
        raw.support && typeof raw.support === "object" ? (raw.support as { url?: unknown; email?: unknown }) : undefined;
      const access = parseAccess(raw.access);
      out.push({
        id: raw.id,
        identity: isIdentity(raw.identity) ? raw.identity : undefined,
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
        supportUrl: httpsUrl(support?.url),
        supportEmail: parseEmail(support?.email),
        capabilities: parseStringArray(raw.capabilities),
        requires: parseRequires(raw.requires),
        requiresExtensions: parseRequiredExtensions(raw.requiresExtensions),
        access,
        // offer 只有閘道同時給了 access 才算數:靜態 registry(GitHub raw)給不出 access,
        // 它寫的 offer 忽略、卡片照免費顯示 —— 不會出現「看起來要錢、按下去卻能裝」。
        offer: access ? parseOffer(raw.offer) : undefined,
        requestedAt: access === "requested" ? parseIsoDate(raw.requestedAt) : undefined,
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

        const text = await fetchFromVariants(source, "/registry.json", (url) => boundedFetchText(url, token));

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
          ...(e instanceof RegistryHttpError ? { status: e.status } : {}),
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

/** 在各種 raw URL 格式上找 manifest.json(見 fetchFromVariants)。 */
async function tryFetchManifest(source: string, id: string, token?: string): Promise<string> {
  if (!isHttpsUrl(source)) {
    throw new Error("source must be an https URL");
  }
  if (!ID_RE.test(id)) {
    throw new Error("invalid extension id");
  }

  return fetchFromVariants(source, `/extensions/${id}/manifest.json`, (url) => boundedFetchText(url, token));
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

  return fetchFromVariants(source, `/extensions/${id}/${filename}`, (url) => boundedFetchText(url, token));
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

  return fetchFromVariants(source, `/extensions/${id}/${filename}`, (url) =>
    boundedFetchBytes(url, token, MAX_ASSET_BYTES),
  );
}

/**
 * 抓 manifest 或插件檔案失敗時,registry 講得出原因的兩種情況,給 manifest 與 install route
 * 共用(其餘失敗由呼叫端照舊回 manifest_fetch_failed):
 *   402 → 402 not_entitled(+ 閘道消毒過的 message)—— 商店與安裝流程顯示「尚未開通」
 *   401 / 403 → 502 source_key_invalid —— 這個來源的金鑰不能用,不是這個插件的問題
 */
export function registryErrorResponse(e: unknown): Response | null {
  if (!(e instanceof RegistryHttpError)) return null;
  if (e.status === 402) {
    return Response.json({ error: "not_entitled", ...(e.detail ? { message: e.detail } : {}) }, { status: 402 });
  }
  if (e.status === 401 || e.status === 403) {
    return Response.json({ error: "source_key_invalid" }, { status: 502 });
  }
  return null;
}

/** 1.56.0:轉送給 registry 的申請內容(`POST <source>/requests` 的 body)。 */
export interface AccessRequestBody {
  extension: string;
  /** 管理員的留言,有寫才送。 */
  note?: string;
  /** 管理員勾了才送;名字與 email 取自登入的帳號,不收瀏覽器送來的值。 */
  contact?: { name: string; email: string };
}

export interface AccessRequestReply {
  /** registry 回的 http 狀態碼(202 = 收到)。 */
  status: number;
  /** 錯誤回應的 `error`(例如 already_granted)。 */
  code?: string;
  /** 回應的 `message`,消毒過、截到 200 字。 */
  message?: string;
}

/** `https://registry.example.com/` → `https://registry.example.com/requests`。 */
export function requestsUrl(source: string): string {
  return `${source.replace(/\/+$/, "")}/requests`;
}

/**
 * 1.56.0 付費插件協定:站內申請。伺服器帶這個來源的 token POST 到 `<source>/requests`
 * (token 永遠不進瀏覽器)。和讀檔的 followRedirects 不同,這裡**完全不跟 redirect**:
 * 申請帶著 token 與管理員的聯絡資料,只送給設定裡那一台主機;任何 3xx 都當失敗。
 * 8 秒逾時;回應只讀前 4 KB(遠低於 1 MB 上限,registry 只會回一句 message)。
 *
 * 呼叫端必須先以 assertKnownRegistrySource 驗證 source;這裡再找一次設定當作 defense-in-depth。
 */
export async function sendAccessRequest(source: string, body: AccessRequestBody): Promise<AccessRequestReply> {
  if (!isHttpsUrl(source)) throw new Error("source must be an https URL");
  const config = (await getRegistrySources()).find((c) => c.url === source);
  if (!config) throw new UnknownRegistrySource(source);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Registry-Protocol": REGISTRY_PROTOCOL,
  };
  if (config.token) headers["Authorization"] = `token ${config.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(requestsUrl(source), {
      method: "POST",
      redirect: "manual",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel();
      throw new Error("redirect refused");
    }
    const { code, detail } = await readErrorBody(res);
    return {
      status: res.status,
      ...(!res.ok && code ? { code } : {}),
      ...(detail ? { message: detail } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
