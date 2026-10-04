import type { JSONContent } from "@tiptap/core";
import { richtextImageSrc, stringToDoc } from "./richtext-schema";
import {
  AGENT_PREVIEW_MAX_LINES,
  AGENT_PREVIEW_MAX_TEXT,
  type AgentPreview,
  type AgentPreviewLine,
} from "../../agent-preview";

// 1.70.0:改 richtext 的一部分,不必整份重寫。
//
// richtext 欄位的值是一份文件,寫入就是整份取代。對人沒差(編輯器送的本來就是整份),
// 對助理是個問題:在一篇長文中間插一張圖,它得把整篇再輸出一次 —— 慢、貴,而且文章一長
// 就寫不完。這裡把「改哪幾塊」算成一份新文件,寫入仍走同一條 provider.update。
//
// 單位是**最上層的區塊**(段落、標題、圖片、清單…)。區塊裡面的字要改,就把那一塊換掉。
//
// 所有修改指的都是**修改前**的那份文件:同一次呼叫裡的第二個修改,不必去算第一個修改
// 之後區塊的位置變成多少。

/** 一次呼叫最多幾個修改。 */
export const RICHTEXT_EDITS_MAX = 50;
/** 大綱裡每一塊顯示幾個字。 */
const OUTLINE_TEXT_MAX = 40;

/** 指到一個既有的區塊:第幾塊(從 0 起),或那一塊裡出現的一段字。 */
export interface RichtextTarget {
  index?: number;
  match?: string;
}

export type RichtextEdit =
  | ({ op: "insert"; position?: "before" | "after" | "start" | "end"; blocks: readonly (string | JSONContent)[] } & RichtextTarget)
  | ({ op: "replace"; blocks: readonly (string | JSONContent)[] } & RichtextTarget)
  | ({ op: "remove" } & RichtextTarget);

export interface RichtextOutlineItem {
  index: number;
  type: string;
  text: string;
}

/** 結果裡的一塊,以及它的來歷:原本就在、這次加入、這次被拿掉(不在新文件裡)。 */
export interface RichtextStep {
  change: "kept" | "added" | "removed";
  node: JSONContent;
}

export type RichtextEditResult =
  | { ok: true; doc: JSONContent; steps: RichtextStep[] }
  | { ok: false; error: string };

/** 一個區塊裡所有的字;圖片沒有字,用替代文字與檔案路徑代表它。 */
function blockText(node: JSONContent): string {
  if (node.type === "image") {
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
    const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
    return `${alt} ${src}`.trim();
  }
  if (node.type === "text") return typeof node.text === "string" ? node.text : "";
  return (node.content ?? []).map(blockText).join("");
}

/** 文件的大綱:每個最上層區塊的位置、種類、開頭的幾個字。 */
export function richtextOutline(doc: JSONContent): RichtextOutlineItem[] {
  return (doc.content ?? []).map((node, index) => {
    const text = blockText(node).replace(/\s+/g, " ").trim();
    return {
      index,
      type: node.type ?? "unknown",
      text: text.length > OUTLINE_TEXT_MAX ? `${text.slice(0, OUTLINE_TEXT_MAX)}…` : text,
    };
  });
}

function outlineText(doc: JSONContent): string {
  const lines = richtextOutline(doc).map((item) => `${item.index} ${item.type}: ${item.text}`);
  return lines.length > 0 ? lines.join(" | ") : "(the field is empty)";
}

/** 字串 → 段落(空行分段);節點原樣。 */
function toBlocks(blocks: readonly (string | JSONContent)[]): JSONContent[] {
  return blocks.flatMap((block) =>
    typeof block === "string" ? (stringToDoc(block).content ?? []) : [block],
  );
}

/** 找出目標是修改前的第幾塊;找不到或不只一塊時回錯誤訊息(附大綱,讓模型改得對)。 */
function resolveTarget(doc: JSONContent, target: RichtextTarget, label: string): number | string {
  const blocks = doc.content ?? [];
  if (typeof target.index === "number") {
    if (Number.isInteger(target.index) && target.index >= 0 && target.index < blocks.length) {
      // 兩個都給 = 對一下:第 N 塊裡要有那段字。確認卡可能放了一陣子才被按下,這期間
      // 內文若被改過,第 N 塊已經是別的東西 —— 寧可退回,不要改錯地方。
      const expected = (target.match ?? "").trim();
      if (expected.length > 0 && !blockText(blocks[target.index]!).includes(expected)) {
        return `${label}: block ${target.index} does not contain "${expected}". Blocks: ${outlineText(doc)}`;
      }
      return target.index;
    }
    return `${label}: there is no block ${target.index}. Blocks: ${outlineText(doc)}`;
  }
  const needle = (target.match ?? "").trim();
  if (needle.length === 0) return `${label}: give \`index\` or \`match\` to say which block.`;
  const hits = blocks.flatMap((node, index) => (blockText(node).includes(needle) ? [index] : []));
  if (hits.length === 1) return hits[0]!;
  return hits.length === 0
    ? `${label}: no block contains "${needle}". Blocks: ${outlineText(doc)}`
    : `${label}: "${needle}" is in blocks ${hits.join(", ")}. Use \`index\`, or a longer \`match\`. Blocks: ${outlineText(doc)}`;
}

/**
 * 把一組修改套到文件上,回傳新文件(不改動傳入的那一份)。
 *
 * 任何一個修改指不到區塊、或兩個修改都要換掉/移除同一塊,整組都不套用。
 */
export function applyRichtextEdits(
  doc: JSONContent,
  edits: readonly RichtextEdit[],
): RichtextEditResult {
  const blocks = doc.content ?? [];
  const before = new Map<number, JSONContent[]>();
  const after = new Map<number, JSONContent[]>();
  const replaced = new Map<number, JSONContent[]>();
  const start: JSONContent[] = [];
  const end: JSONContent[] = [];
  const push = (map: Map<number, JSONContent[]>, index: number, added: JSONContent[]) =>
    map.set(index, [...(map.get(index) ?? []), ...added]);

  for (const [i, edit] of edits.entries()) {
    const label = `edits[${i}]`;
    if (edit.op === "insert" && (edit.position === "start" || edit.position === "end")) {
      (edit.position === "start" ? start : end).push(...toBlocks(edit.blocks));
      continue;
    }
    // 沒說放哪裡的 insert:接在文件最後。
    if (edit.op === "insert" && edit.position === undefined && edit.index === undefined && edit.match === undefined) {
      end.push(...toBlocks(edit.blocks));
      continue;
    }
    const index = resolveTarget(doc, edit, label);
    if (typeof index === "string") return { ok: false, error: index };
    if (edit.op === "insert") {
      push(edit.position === "before" ? before : after, index, toBlocks(edit.blocks));
      continue;
    }
    if (replaced.has(index)) {
      return { ok: false, error: `${label}: block ${index} is already replaced or removed by an earlier edit.` };
    }
    replaced.set(index, edit.op === "replace" ? toBlocks(edit.blocks) : []);
  }

  const added = (nodes: readonly JSONContent[]): RichtextStep[] =>
    nodes.map((node) => ({ change: "added", node }));
  const steps: RichtextStep[] = [
    ...added(start),
    ...blocks.flatMap((block, index): RichtextStep[] => {
      const replacement = replaced.get(index);
      return [
        ...added(before.get(index) ?? []),
        // 換掉 = 舊的拿掉、新的放在同一個位置。
        ...(replacement ? [{ change: "removed" as const, node: block }, ...added(replacement)] : [{ change: "kept" as const, node: block }]),
        ...added(after.get(index) ?? []),
      ];
    }),
    ...added(end),
  ];
  const content = steps.filter((step) => step.change !== "removed").map((step) => step.node);
  return { ok: true, doc: { ...doc, content }, steps };
}

/** 一塊 → 預覽的一行。圖片帶路徑(認不出來的當成一般文字行),標題標出來。 */
function previewLine(step: RichtextStep): AgentPreviewLine {
  const { node } = step;
  const clip = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > AGENT_PREVIEW_MAX_TEXT ? `${flat.slice(0, AGENT_PREVIEW_MAX_TEXT - 1)}…` : flat;
  };
  if (node.type === "image") {
    const image = richtextImageSrc(node.attrs?.src);
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
    return image ? { change: step.change, text: clip(alt), image } : { change: step.change, text: clip(blockText(node)) };
  }
  return {
    change: step.change,
    text: clip(blockText(node)),
    ...(node.type === "heading" ? { heading: true } : {}),
  };
}

/**
 * 修改的結果 → 確認卡的預覽:改動的每一塊,加上緊鄰的前後各一塊沒變的內容當位置,其餘沒變的
 * 收成「中間 N 段」。行數超過上限就不給預覽(回 undefined,卡片退回參數表)—— 只畫前幾十行
 * 會讓人以為那就是全部的改動。
 */
export function richtextChangePreview(steps: readonly RichtextStep[]): AgentPreview | undefined {
  const changedAt = (i: number) => i >= 0 && i < steps.length && steps[i]!.change !== "kept";
  const near = (i: number) => changedAt(i - 1) || changedAt(i + 1);
  const lines: AgentPreviewLine[] = [];
  let skipped = 0;
  for (const [i, step] of steps.entries()) {
    if (step.change === "kept" && !near(i)) {
      skipped += 1;
      continue;
    }
    if (skipped > 0) lines.push({ change: "gap", count: skipped });
    skipped = 0;
    lines.push(previewLine(step));
  }
  if (skipped > 0) lines.push({ change: "gap", count: skipped });
  const changed = lines.some((line) => line.change === "added" || line.change === "removed");
  return changed && lines.length <= AGENT_PREVIEW_MAX_LINES ? { kind: "changes", lines } : undefined;
}
