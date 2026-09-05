// wrangler.jsonc 的讀取與外科式寫回。
//
// 這個模組只准外科式修改兩種 setup 擁有的欄位:
//   - 租戶命名:name、WORKER_SELF_REFERENCE.service、D1/R2 的資源名稱。
//   - D1 的 database_id。
// main / triggers / assets 等執行行為欄位一律不動。用 span 替換而不是重新序列化,
// 這條鐵律就不是靠自律,而是結構上做不到:編輯區間只會落在允許的值字面量上。

import {
  applyEdits,
  getMember,
  getStringMember,
  parseJsonc,
  quoteJsonString,
  skipTrivia,
  type JsoncEdit,
  type JsoncNode,
  type Span,
} from "./jsonc.js";
import { isPlaceholderId } from "./wrangler.js";

export interface D1Entry {
  binding: string;
  databaseName: string;
  /** database_name 值字面量的區間。 */
  nameSpan: Span;
  /** 目前設定檔裡的 id(可能是佔位值)。 */
  currentId: string | undefined;
  /** `database_id` 值字面量的區間;鍵不存在時為 undefined。 */
  idSpan: Span | undefined;
  /** 鍵不存在時,新的成員要插在這個位移(= database_name 值的結尾)。 */
  insertAfter: number | undefined;
  /** 有沒有宣告 migrations_dir —— 決定 setup 要不要對這個 DB 跑 migrations。 */
  hasMigrationsDir: boolean;
}

export interface R2Entry {
  binding: string;
  bucketName: string;
  /** bucket_name 值字面量的區間。 */
  nameSpan: Span;
}

export interface WranglerConfig {
  /** Worker 名稱(secret / deploy 都掛在它身上)。 */
  workerName: string | undefined;
  /** name 值字面量的區間。 */
  workerNameSpan: Span | undefined;
  /** WORKER_SELF_REFERENCE service 值與其 span。 */
  selfReferenceService: string | undefined;
  selfReferenceServiceSpan: Span | undefined;
  /** setup 寫入的站點 slug;它是確認本機配置曾被安全命名的證據。 */
  siteSlug: string | undefined;
  siteSlugSpan: Span | undefined;
  /** 已指定的 Cloudflare 帳號;undefined 代表設定檔沒寫,可以安全補上。 */
  accountId: string | undefined;
  d1: D1Entry[];
  r2: R2Entry[];
}

export class ConfigShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigShapeError";
  }
}

function readD1(node: JsoncNode): D1Entry[] {
  const member = getMember(node, "d1_databases");
  if (!member) return [];
  if (member.value.kind !== "array") {
    throw new ConfigShapeError("wrangler.jsonc d1_databases is not an array");
  }
  return member.value.items.map((item, i) => {
    if (item.kind !== "object") {
      throw new ConfigShapeError(`d1_databases[${i}] is not an object`);
    }
    const databaseName = getStringMember(item, "database_name");
    if (!databaseName) {
      throw new ConfigShapeError(`d1_databases[${i}] missing database_name`);
    }
    const idMember = getMember(item, "database_id");
    const nameMember = getMember(item, "database_name");
    return {
      binding: getStringMember(item, "binding") ?? `d1_databases[${i}]`,
      databaseName,
      nameSpan: nameMember!.value.span,
      currentId:
        idMember && idMember.value.kind === "string" ? idMember.value.value : undefined,
      idSpan:
        idMember && idMember.value.kind === "string" ? idMember.value.span : undefined,
      insertAfter: idMember ? undefined : nameMember?.value.span.end,
      hasMigrationsDir: getMember(item, "migrations_dir") !== undefined,
    };
  });
}

function readR2(node: JsoncNode): R2Entry[] {
  const member = getMember(node, "r2_buckets");
  if (!member) return [];
  if (member.value.kind !== "array") {
    throw new ConfigShapeError("wrangler.jsonc r2_buckets is not an array");
  }
  return member.value.items.map((item, i) => {
    if (item.kind !== "object") {
      throw new ConfigShapeError(`r2_buckets[${i}] is not an object`);
    }
    const bucketName = getStringMember(item, "bucket_name");
    if (!bucketName) {
      throw new ConfigShapeError(`r2_buckets[${i}] missing bucket_name`);
    }
    return {
      binding: getStringMember(item, "binding") ?? `r2_buckets[${i}]`,
      bucketName,
      nameSpan: getMember(item, "bucket_name")!.value.span,
    };
  });
}

function readSelfReference(node: JsoncNode): {
  service: string | undefined;
  span: Span | undefined;
} {
  const member = getMember(node, "services");
  if (!member || member.value.kind !== "array") return { service: undefined, span: undefined };
  const entry = member.value.items.find((item) =>
    item.kind === "object" && getStringMember(item, "binding") === "WORKER_SELF_REFERENCE",
  );
  if (!entry || entry.kind !== "object") return { service: undefined, span: undefined };
  const serviceMember = getMember(entry, "service");
  return {
    service: serviceMember && serviceMember.value.kind === "string" ? serviceMember.value.value : undefined,
    span: serviceMember && serviceMember.value.kind === "string" ? serviceMember.value.span : undefined,
  };
}

function readSiteSlug(node: JsoncNode): { slug: string | undefined; span: Span | undefined } {
  const vars = getMember(node, "vars");
  if (!vars || vars.value.kind !== "object") return { slug: undefined, span: undefined };
  const slug = getMember(vars.value, "CMS_SITE_SLUG");
  return {
    slug: slug && slug.value.kind === "string" ? slug.value.value : undefined,
    span: slug && slug.value.kind === "string" ? slug.value.span : undefined,
  };
}

/** 解析設定檔內容 → 我們在乎的那幾個欄位。 */
export function readWranglerConfig(text: string): WranglerConfig {
  const root = parseJsonc(text);
  if (root.kind !== "object") {
    throw new ConfigShapeError("wrangler.jsonc root is not an object");
  }
  const workerNameMember = getMember(root, "name");
  const selfReference = readSelfReference(root);
  const siteSlug = readSiteSlug(root);
  return {
    workerName: getStringMember(root, "name"),
    workerNameSpan:
      workerNameMember && workerNameMember.value.kind === "string"
        ? workerNameMember.value.span
        : undefined,
    selfReferenceService: selfReference.service,
    selfReferenceServiceSpan: selfReference.span,
    siteSlug: siteSlug.slug,
    siteSlugSpan: siteSlug.span,
    accountId: getStringMember(root, "account_id"),
    d1: readD1(root),
    r2: readR2(root),
  };
}

export interface SiteResources {
  siteSlug: string;
  workerName: string;
  selfReferenceService: string;
  d1Names: readonly [string, string];
  r2Names: readonly [string, string];
}

/**
 * 一次替換新站點的六個租戶邊界值。沒有任何編輯時不改 mtime。
 * 此函式刻意不碰 database_id:名稱先落地讓重跑能安全地認回同一組資源,id 仍由 writeD1Ids 回填。
 */
export function writeSiteResources(text: string, target: SiteResources): ConfigWriteResult {
  const config = readWranglerConfig(text);
  if (!config.workerNameSpan || !config.selfReferenceServiceSpan || !config.siteSlugSpan) {
    throw new ConfigShapeError(
      "wrangler.jsonc missing name, WORKER_SELF_REFERENCE.service, or vars.CMS_SITE_SLUG",
    );
  }
  if (config.d1.length !== target.d1Names.length || config.r2.length !== target.r2Names.length) {
    throw new ConfigShapeError("wrangler.jsonc D1/R2 count not two of each as expected, refusing to rename");
  }

  const edits: JsoncEdit[] = [];
  const changed: string[] = [];
  const replace = (span: Span, current: string | undefined, next: string, field: string) => {
    if (current === next) return;
    edits.push({ span, replacement: quoteJsonString(next) });
    changed.push(field);
  };

  replace(config.workerNameSpan, config.workerName, target.workerName, "name");
  replace(config.siteSlugSpan, config.siteSlug, target.siteSlug, "vars.CMS_SITE_SLUG");
  replace(
    config.selfReferenceServiceSpan,
    config.selfReferenceService,
    target.selfReferenceService,
    "WORKER_SELF_REFERENCE.service",
  );
  for (const [i, entry] of config.d1.entries()) {
    replace(entry.nameSpan, entry.databaseName, target.d1Names[i], `d1_databases[${i}].database_name`);
  }
  for (const [i, entry] of config.r2.entries()) {
    replace(entry.nameSpan, entry.bucketName, target.r2Names[i], `r2_buckets[${i}].bucket_name`);
  }
  return { text: applyEdits(text, edits), changed };
}

/** database_name → 要寫進去的 uuid。 */
export type D1IdAssignments = ReadonlyMap<string, string>;

export interface ConfigWriteResult {
  text: string;
  /** 真的被改到的 database_name(已經是正確值的不列入)。 */
  changed: string[];
}

/**
 * 把 uuid 寫回設定檔內容。
 *
 * 冪等:值已經等於目標 uuid 的項目完全不產生編輯,`changed` 也不會列它 ——
 * 所以重跑 setup 時檔案的 mtime 都不會動。
 *
 * 注意這個函式吃的是**當下讀到的 text**,不是先前偵測階段那份。呼叫端必須在寫入前
 * 重讀一次:同一個 repo 裡可能有別人正在改 main / triggers,用舊 text 算出來的
 * 位移會落在錯的位置。
 */
export function writeD1Ids(
  text: string,
  assignments: D1IdAssignments,
): ConfigWriteResult {
  const config = readWranglerConfig(text);
  const edits: JsoncEdit[] = [];
  const changed: string[] = [];

  for (const entry of config.d1) {
    const target = assignments.get(entry.databaseName);
    if (target === undefined) continue;
    if (entry.currentId === target) continue; // 已經對了 → 不動

    if (entry.idSpan) {
      edits.push({ span: entry.idSpan, replacement: quoteJsonString(target) });
    } else if (entry.insertAfter !== undefined) {
      // 鍵不存在(有人手工砍過設定檔)→ 補在 database_name 之後。成員後面必定接著
      // `,` 或 `}`,所以插入 `, "database_id": "…"` 在任何情況下都仍是合法 JSONC。
      edits.push({
        span: { start: entry.insertAfter, end: entry.insertAfter },
        replacement: `, "database_id": ${quoteJsonString(target)}`,
      });
    } else {
      throw new ConfigShapeError(
        `could not locate database_id field for ${entry.databaseName}, manually enter ${target}`,
      );
    }
    changed.push(entry.databaseName);
  }

  return { text: applyEdits(text, edits), changed };
}

/** 設定檔裡還是佔位值(或空)的 D1 項目 —— 部署前一定要換掉的那些。 */
export function placeholderD1(config: WranglerConfig): D1Entry[] {
  return config.d1.filter((e) => isPlaceholderId(e.currentId));
}

// ---- vars ---------------------------------------------------------------
// extension 的**非 secret** 設定落在這裡。
//
// 🔴 wrangler.jsonc 會進版控(cms 是公開 repo)。這個模組**只**被非 secret 的路徑
// 呼叫;secret 的值走 .dev.vars + `wrangler secret put`,永遠不經過這裡。
// 分界本身寫在 settings.ts:storageFor()。

/** 目前 vars 區塊裡有哪些鍵(值原樣帶回,供 preflight 判斷是否為空)。 */
export function readVars(text: string): Map<string, unknown> {
  const root = parseJsonc(text);
  const out = new Map<string, unknown>();
  const vars = getMember(root, "vars");
  if (!vars || vars.value.kind !== "object") return out;
  for (const member of vars.value.members) {
    const node = member.value;
    if (node.kind === "string" || node.kind === "number" || node.kind === "boolean") {
      out.set(member.key, node.value);
    } else if (node.kind === "null") {
      out.set(member.key, null);
    } else {
      // 物件 / 陣列值:記成「存在但我們不解讀」。preflight 只需要知道有沒有。
      out.set(member.key, undefined);
    }
  }
  return out;
}

export type VarValue = string | number | boolean;

/**
 * 把一組 key/value 寫進 vars 區塊。
 *
 * 冪等:值已經一樣的完全不產生編輯(`changed` 也不列),所以重跑不動 mtime。
 * 新鍵插在**最後一個成員的值之後**,而不是收尾 `}` 之前 —— 後者遇到既有的尾逗號
 * 會產出 `{ "a": 1, , "b": 2 }` 這種壞掉的 JSONC,而且錯誤要等到 deploy 才炸。
 * 從頭序列化整個物件當然更簡單,但那會吃掉檔案裡的中文註解(見本檔與 jsonc.ts 檔頭)。
 */
export function writeVars(
  text: string,
  entries: ReadonlyMap<string, VarValue>,
): ConfigWriteResult {
  if (entries.size === 0) return { text, changed: [] };
  const root = parseJsonc(text);
  const varsMember = getMember(root, "vars");
  if (!varsMember || varsMember.value.kind !== "object") {
    throw new ConfigShapeError(
      "wrangler.jsonc has no `vars` object; add `\"vars\": {}` and rerun (refusing to synthesize it," +
        " because inserting a new top-level member is the one edit that could land between a comment and the field it documents)",
    );
  }
  const vars = varsMember.value;
  const existing = new Map(vars.members.map((m) => [m.key, m]));

  const edits: JsoncEdit[] = [];
  const changed: string[] = [];
  const additions: string[] = [];

  for (const [key, value] of entries) {
    const literal = JSON.stringify(value);
    const member = existing.get(key);
    if (member) {
      const current = text.slice(member.value.span.start, member.value.span.end);
      if (current === literal) continue; // 已經一樣 → 不動
      edits.push({ span: member.value.span, replacement: literal });
      changed.push(key);
      continue;
    }
    additions.push(`${quoteJsonString(key)}: ${literal}`);
    changed.push(key);
  }

  if (additions.length > 0) {
    const last = vars.members[vars.members.length - 1];
    if (last) {
      const insertAt = last.value.span.end;
      edits.push({
        span: { start: insertAt, end: insertAt },
        replacement: `, ${additions.join(", ")}`,
      });
    } else {
      // 空的 `{}`:插在左大括號之後,而且不能帶前導逗號。
      const insertAt = skipTrivia(text, vars.span.start + 1);
      edits.push({
        span: { start: insertAt, end: insertAt },
        replacement: additions.join(", "),
      });
    }
  }

  return { text: applyEdits(text, edits), changed };
}

/**
 * 把 `account_id` 寫進 wrangler.jsonc 的根物件。
 *
 * 為什麼需要:登入多個 Cloudflare 帳號時,**每一個** wrangler 指令都會停下來問要用
 * 哪個(deploy、populate-cache、secret put…)。setup 只把選擇放進 process.env,
 * 那只活在那一次執行裡。寫進設定檔才是 wrangler 自己在錯誤訊息裡建議的解法。
 *
 * 插入位置刻意選在 `$schema` 之後:jsonc 裡的註解一律壓在它所描述的欄位**上方**,
 * 所以任何「欄位與其上方註解之間」的插入都會把說明孤立掉。`$schema` 與下一個欄位
 * 的註解之間是唯一保證安全的縫。沒有 `$schema` 就退回根 `{` 之後(那之後只會是
 * 檔案層級的說明,不屬於任何單一欄位)。
 */
export function writeAccountId(text: string, accountId: string): ConfigWriteResult {
  const root = parseJsonc(text);
  if (root.kind !== "object") return { text, changed: [] };

  const existing = getMember(root, "account_id");
  if (existing) {
    // 已經是同一個值就不動,避免製造無意義的 diff。
    if (existing.value.kind === "string" && existing.value.value === accountId) {
      return { text, changed: [] };
    }
    return {
      changed: ["account_id"],
      text:
        text.slice(0, existing.value.span.start) +
        JSON.stringify(accountId) +
        text.slice(existing.value.span.end),
    };
  }

  const anchor = getMember(root, "$schema");
  const at = anchor
    ? skipInsertPoint(text, anchor.value.span.end)
    : root.span.start + 1;
  return {
    changed: ["account_id"],
    text: `${text.slice(0, at)}\n  "account_id": ${JSON.stringify(accountId)},${text.slice(at)}`,
  };
}

/** 越過值後面緊接的逗號,讓插入落在「逗號之後、下一個註解之前」。 */
function skipInsertPoint(text: string, from: number): number {
  let i = from;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  return text[i] === "," ? i + 1 : from;
}
