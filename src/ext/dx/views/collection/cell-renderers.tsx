import type { ReactNode } from "react";
import type { DeclarativeField } from "../../manifest";
import { richtextToPlainText } from "../../fields/richtext-schema";
import { StatusBadge } from "../StatusBadge";
import { fmtDate, truncate } from "../field-utils";
import { RelationCell } from "./RelationCell";
import { MediaImage } from "@/components/ui/media-image";

// 依 field type 把 data 值渲染為表格 cell。純展示,server-renderable(無 hooks)。
// Paper & Ink:數字 tabular-nums、boolean ring-dot、select 借 StatusBadge 藥丸、
// media 小縮圖(/api/files/<key>,fallback 檔案 chip)、richtext/json 收斂為靜音摘要。

const EMPTY = <span className="text-black/25">—</span>;

/** 極短技術 chip(json、media fallback)。 */
function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-[6px] bg-black/[0.04] px-1.5 py-0.5 font-mono text-[11px] lowercase text-black/45">
      {children}
    </span>
  );
}

/** login 的 ring-dot 狀態記號:size-3 圈 + size-1 內點。 */
function RingDot({ on }: { on: boolean }) {
  return (
    <span
      className={
        "relative inline-flex size-3 items-center justify-center rounded-full " +
        (on ? "ring-1 ring-[rgb(86,114,228)]" : "ring-1 ring-black/20")
      }
      aria-hidden
    >
      <span
        className={
          "size-1 rounded-full " + (on ? "bg-[rgb(86,114,228)]" : "bg-black/25")
        }
      />
    </span>
  );
}

function MediaCell({ value }: { value: unknown }) {
  if (typeof value !== "string" || value.length === 0) return EMPTY;
  const key = value;
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  const isImage = ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"].includes(
    ext,
  );
  if (isImage) {
    // 小縮圖;shadow-ring 取代邊框。size-8 已鎖死版位(免 CLS),所以不放
    // width/height 屬性 —— 那會跟 MediaImage 的 h-auto 打架。srcset 上限只到最小
    // 的一格:32px 的格子沒理由下載 1920w。
    return (
      <MediaImage
        mediaKey={key}
        alt=""
        maxWidth={320}
        sizes="32px"
        className="size-8 rounded-[6px] object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.06)]"
      />
    );
  }
  return <Chip>{truncate(key.split("/").pop() ?? key, 18)}</Chip>;
}

export function renderCell(field: DeclarativeField, value: unknown): ReactNode {
  if (value === undefined || value === null || value === "") {
    // boolean false 是有效值,交給下方分支;其餘空值統一 em-dash。
    if (field.type !== "boolean") return EMPTY;
  }

  switch (field.type) {
    case "text":
    case "slug":
      return (
        <span className="text-black/85">
          {truncate(String(value), field.type === "slug" ? 40 : 60)}
        </span>
      );
    case "number":
      return (
        <span className="tabular-nums text-black/85">{String(value)}</span>
      );
    case "boolean":
      return (
        <span className="inline-flex items-center gap-1.5 text-black/55">
          <RingDot on={value === true} />
          <span className="text-[12px]">{value === true ? "yes" : "no"}</span>
        </span>
      );
    case "date": {
      const d = fmtDate(value);
      return d ? (
        <span className="tabular-nums text-black/70">{d}</span>
      ) : (
        EMPTY
      );
    }
    case "select":
      return <StatusBadge status={String(value)} />;
    case "media":
      return <MediaCell value={value} />;
    case "richtext": {
      const text = richtextToPlainText(value, 80);
      return text ? (
        <span className="text-black/55">{text}</span>
      ) : (
        EMPTY
      );
    }
    case "json":
      return <Chip>{"{…}"}</Chip>;
    case "relation": {
      // 08 §1: single entry id → resolved title chip (client fetch).
      const id = typeof value === "string" ? value : "";
      if (id === "" || !field.to) return EMPTY;
      return <RelationCell to={field.to} ids={[id]} />;
    }
    case "relations": {
      // 08 §1: ordered id array → title chips (client fetch, "+N" overflow).
      const rels = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];
      if (rels.length === 0 || !field.to) return EMPTY;
      return <RelationCell to={field.to} ids={rels} />;
    }
    case "group": {
      // Tier 2 v1.2: group → first non-empty subfield value as a compact
      // summary; em-dash when the group is empty.
      const obj =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const summary = firstScalarSummary(obj);
      return summary ? (
        <span className="text-black/70">{truncate(summary, 60)}</span>
      ) : (
        EMPTY
      );
    }
    case "repeater": {
      // Tier 2 v1.2: repeater → "N items" count chip.
      const n = Array.isArray(value) ? value.length : 0;
      if (n === 0) return EMPTY;
      return <Chip>{`${n} item${n === 1 ? "" : "s"}`}</Chip>;
    }
    case "blocks": {
      // Tier 2 v1.2: blocks → "N blocks" count chip.
      const n = Array.isArray(value) ? value.length : 0;
      if (n === 0) return EMPTY;
      return <Chip>{`${n} block${n === 1 ? "" : "s"}`}</Chip>;
    }
    default:
      return <span className="text-black/85">{truncate(String(value))}</span>;
  }
}

/** First renderable scalar (string/number) in an object, for group summaries. */
function firstScalarSummary(obj: Record<string, unknown>): string {
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}
