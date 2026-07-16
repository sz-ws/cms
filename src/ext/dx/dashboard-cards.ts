import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contents } from "@/lib/schema";
import { displayValue, pickTitleField } from "./views/field-utils";
import type { DeclarativeDashboardCard } from "./manifest";
import type { Extension } from "../types";

// roadmap #16:把 enabled extensions 宣告的 dashboardCards 解析成可渲染的資料。
//   stat   → 對共用 contents 表做 count(*)(可選 status filter)。
//   recent → 取最近更新(updatedAt desc)的 limit 筆,並抽出每筆的顯示標題。
//
// 韌性(spec §5 的精神:dashboard 絕不因某個 extension 的壞資料而整頁掛掉):
//   每張卡各自 try/catch —— 單卡的 contentType 未宣告、或 DB 查詢失敗 → console.error
//   並「略過該卡」回 null,絕不 throw。resolveDashboardCards 過濾掉 null。
//
// adminHref 決策:連到該 extension 的 admin 根頁 `/admin/ext/<extId>`(即 aggregate.ts
// resolveCollectionSlug 的 fallback 目標——當 content type 的 collection adminPage 用
// 預設 slug ""(seed 皆如此)時,此 URL 正好就是該 type 的 collection 列表,edit 頁則為
// `/admin/ext/<extId>/edit?id=`)。此處刻意只依賴 Extension.id,不重讀 manifest/DB,讓資料
// 層與 declarative_extensions 表解耦(單元測試僅需 contents 表即可覆蓋)。

const DEFAULT_RECENT_LIMIT = 5;

/** recent 卡的單列(對映一筆 content entry)。 */
export interface ResolvedRecentEntry {
  id: string;
  title: string;
  status: "draft" | "published";
  updatedAt: number;
  editHref: string;
}

/** 一張解析完成、可直接渲染的 dashboard 卡。 */
export interface ResolvedDashboardCard {
  extId: string;
  extName: string;
  kind: "stat" | "recent";
  title: string;
  /** 完整 content type key "<extId>.<name>"(查 contents 表用)。 */
  contentType: string;
  /** 該 extension 的 admin 根頁(見檔頭決策)。 */
  adminHref: string;
  /** stat 專用:符合條件的 entry 總數。 */
  count?: number;
  /** recent 專用:最近更新的 entry 列。 */
  entries?: ResolvedRecentEntry[];
}

/** 解析單張卡;任何失敗都吞成 null(呼叫端過濾),不 throw。 */
async function resolveCard(
  ext: Extension,
  card: DeclarativeDashboardCard,
): Promise<ResolvedDashboardCard | null> {
  const ct = (ext.contentTypes ?? []).find((c) => c.name === card.contentType);
  if (!ct) {
    // 卡引用了未宣告的 contentType(interpret 端 manifest schema 應已擋下,但 code
    // extension 可能繞過驗證直接設定 dashboardCards):略過此卡,不 throw。
    console.error(
      `[dashboard-cards] ext="${ext.id}" card references unknown content type "${card.contentType}"; skipped`,
    );
    return null;
  }

  const typeKey = `${ext.id}.${card.contentType}`;
  const adminHref = `/admin/ext/${ext.id}`;
  const title = card.title ?? ct.label ?? ct.name;

  try {
    if (card.kind === "stat") {
      const where = card.status
        ? and(eq(contents.type, typeKey), eq(contents.status, card.status))
        : eq(contents.type, typeKey);
      const rows = await db()
        .select({ n: count() })
        .from(contents)
        .where(where);
      return {
        extId: ext.id,
        extName: ext.name,
        kind: "stat",
        title,
        contentType: typeKey,
        adminHref,
        count: rows[0]?.n ?? 0,
      };
    }

    // recent
    const limit = card.limit ?? DEFAULT_RECENT_LIMIT;
    const rows = await db()
      .select()
      .from(contents)
      .where(eq(contents.type, typeKey))
      .orderBy(desc(contents.updatedAt))
      .limit(limit);

    // 顯示標題:沿用既有的 pickTitleField + displayValue(同 aggregate.ts 的 recent
    // 取標題策略——slugField 欄位優先,否則第一個 text 欄位,否則第一個欄位);抽不到
    // 有意義的字串時退回 entry id。
    const titleField = pickTitleField(ct.fields, ct.slugField);
    const entries: ResolvedRecentEntry[] = rows.map((row) => {
      let data: Record<string, unknown> = {};
      try {
        const j = JSON.parse(row.data) as unknown;
        if (j && typeof j === "object") data = j as Record<string, unknown>;
      } catch {
        data = {};
      }
      const raw = titleField ? data[titleField.key] : undefined;
      const shown = titleField ? displayValue(titleField, raw).trim() : "";
      return {
        id: row.id,
        title: shown.length > 0 ? shown : row.id,
        status: row.status === "published" ? "published" : "draft",
        updatedAt: row.updatedAt,
        editHref: `${adminHref}/edit?id=${encodeURIComponent(row.id)}`,
      };
    });
    return {
      extId: ext.id,
      extName: ext.name,
      kind: "recent",
      title,
      contentType: typeKey,
      adminHref,
      entries,
    };
  } catch (e) {
    console.error(
      `[dashboard-cards] ext="${ext.id}" card "${card.contentType}" query failed; skipped`,
      e,
    );
    return null;
  }
}

/**
 * 解析一組 extensions 貢獻的 dashboard 卡。每張卡獨立解析且獨立容錯(見 resolveCard);
 * 失敗的卡被略過,回傳只含成功解析者的陣列,保留宣告順序。
 */
export async function resolveDashboardCards(
  exts: Extension[],
): Promise<ResolvedDashboardCard[]> {
  const jobs: Promise<ResolvedDashboardCard | null>[] = [];
  for (const ext of exts) {
    for (const card of ext.dashboardCards ?? []) {
      jobs.push(resolveCard(ext, card));
    }
  }
  const settled = await Promise.all(jobs);
  return settled.filter((c): c is ResolvedDashboardCard => c !== null);
}
