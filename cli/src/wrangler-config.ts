// wrangler.jsonc 的讀取與外科式寫回。
//
// 這個模組的鐵律:**只碰 d1_databases[].database_id 的值**。
// wrangler.jsonc 裡的 main / triggers / assets / services 一律不動 —— 那些欄位由別人維護,
// 而且改錯的後果(worker 進入點沒了、cron 停掉)遠比省下的手工大。用 span 替換而不是
// 重新序列化,這條鐵律就不是靠自律,而是結構上做不到:編輯區間只會落在那些值的字面量上。

import {
  applyEdits,
  getMember,
  getStringMember,
  parseJsonc,
  quoteJsonString,
  type JsoncEdit,
  type JsoncNode,
  type Span,
} from "./jsonc.js";
import { isPlaceholderId } from "./wrangler.js";

export interface D1Entry {
  binding: string;
  databaseName: string;
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
}

export interface WranglerConfig {
  /** Worker 名稱(secret / deploy 都掛在它身上)。 */
  workerName: string | undefined;
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
    throw new ConfigShapeError("wrangler.jsonc 的 d1_databases 不是陣列");
  }
  return member.value.items.map((item, i) => {
    if (item.kind !== "object") {
      throw new ConfigShapeError(`d1_databases[${i}] 不是物件`);
    }
    const databaseName = getStringMember(item, "database_name");
    if (!databaseName) {
      throw new ConfigShapeError(`d1_databases[${i}] 缺少 database_name`);
    }
    const idMember = getMember(item, "database_id");
    const nameMember = getMember(item, "database_name");
    return {
      binding: getStringMember(item, "binding") ?? `d1_databases[${i}]`,
      databaseName,
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
    throw new ConfigShapeError("wrangler.jsonc 的 r2_buckets 不是陣列");
  }
  return member.value.items.map((item, i) => {
    if (item.kind !== "object") {
      throw new ConfigShapeError(`r2_buckets[${i}] 不是物件`);
    }
    const bucketName = getStringMember(item, "bucket_name");
    if (!bucketName) {
      throw new ConfigShapeError(`r2_buckets[${i}] 缺少 bucket_name`);
    }
    return {
      binding: getStringMember(item, "binding") ?? `r2_buckets[${i}]`,
      bucketName,
    };
  });
}

/** 解析設定檔內容 → 我們在乎的那幾個欄位。 */
export function readWranglerConfig(text: string): WranglerConfig {
  const root = parseJsonc(text);
  if (root.kind !== "object") {
    throw new ConfigShapeError("wrangler.jsonc 的根節點不是物件");
  }
  return {
    workerName: getStringMember(root, "name"),
    d1: readD1(root),
    r2: readR2(root),
  };
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
        `無法定位 ${entry.databaseName} 的 database_id 欄位,請手動填入 ${target}`,
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
