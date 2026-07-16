import type { JSONContent } from "@tiptap/core";

// C.5b §1: single source of truth for the richtext Tiptap schema. Both the
// client editor (RichtextField) and the server renderer (views/richtext-render)
// build their extension set from the SAME fixed list here. This is a
// security-reviewed invariant: the server MUST NOT render marks/nodes the
// editor could not have produced, and generateHTML must run against a known,
// closed set of extensions (no arbitrary HTML passthrough).
//
// Stored value shape (dx-field-components.md `richtext` row): a Tiptap JSON
// document object `{ type: "doc", content: [...] }`. NEVER raw HTML.
//
// Back-compat decision (documented in content-provider.ts too): a legacy plain
// STRING value is treated as a single paragraph doc. `stringToDoc` performs
// that upgrade; the validator and renderer both accept string OR doc.

/** The Tiptap document root type-name we emit/accept. */
export const DOC_TYPE = "doc" as const;

/** True when `v` is a plausibly-shaped Tiptap doc object (not a string). */
export function isTiptapDoc(v: unknown): v is JSONContent {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { type?: unknown }).type === DOC_TYPE
  );
}

// Phase E §6: write-time defense-in-depth. `isTiptapDoc` above only checks the
// root shape; a doc could still carry node/mark types the renderer doesn't
// know about, or be pathologically deep/large. isValidRichtextDoc walks the
// WHOLE tree and rejects anything outside this allowlist, keeping the
// server's write-time contract as strict as its render-time one.
//
// KEEP THIS ALLOWLIST IN SYNC with:
//   - src/ext/dx/fields/richtext-extensions.ts (client editor's Tiptap
//     extension set — what the editor CAN produce)
//   - src/ext/dx/views/richtext-render.tsx (server renderer's switch
//     statements in renderBlock/applyMarks — what the server WILL render)
// All three lists must describe the same closed set. StarterKit (configured
// with heading levels [2, 3]) provides every node below except image, which
// is registered separately; Link is the only extra mark beyond StarterKit's.
const ALLOWED_NODE_TYPES = new Set<string>([
  "doc",
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "image",
  "text",
  "hardBreak",
]);

const ALLOWED_MARK_TYPES = new Set<string>([
  "bold",
  "italic",
  "strike",
  "code",
  "link",
]);

// Caps mirror the DoS-guard philosophy applied to repeater/blocks/json in
// content-provider.ts — bound worst-case tree shape before it's ever stored.
const RICHTEXT_MAX_DEPTH = 50;
const RICHTEXT_MAX_NODES = 5000;

interface WalkState {
  nodeCount: number;
}

/** Recursively validate one node: type ∈ allowlist, marks ∈ allowlist, depth
 * and total node-count within caps. Returns false as soon as anything fails
 * (short-circuits — no need to keep walking an already-rejected doc). */
function walkNode(node: unknown, depth: number, state: WalkState): boolean {
  if (depth > RICHTEXT_MAX_DEPTH) return false;
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;

  state.nodeCount++;
  if (state.nodeCount > RICHTEXT_MAX_NODES) return false;

  const n = node as JSONContent;
  if (typeof n.type !== "string" || !ALLOWED_NODE_TYPES.has(n.type)) return false;

  if (n.marks !== undefined) {
    if (!Array.isArray(n.marks)) return false;
    for (const mark of n.marks) {
      if (
        mark === null ||
        typeof mark !== "object" ||
        typeof (mark as { type?: unknown }).type !== "string" ||
        !ALLOWED_MARK_TYPES.has((mark as { type: string }).type)
      )
        return false;
    }
  }

  if (n.content !== undefined) {
    if (!Array.isArray(n.content)) return false;
    for (const child of n.content) {
      if (!walkNode(child, depth + 1, state)) return false;
    }
  }

  return true;
}

/**
 * Full write-time validation of a Tiptap doc: root shape (isTiptapDoc) PLUS a
 * recursive walk confirming every node.type/mark.type is in the allowlist
 * above, within depth/node-count caps. Used by content-provider.ts `case
 * "richtext"` to REJECT (not silently drop) a doc containing unknown
 * nodes/marks or excessive size — the legacy string→doc upgrade path
 * (stringToDoc) always produces a valid doc, so it never hits this check.
 */
export function isValidRichtextDoc(v: unknown): v is JSONContent {
  if (!isTiptapDoc(v)) return false;
  const state: WalkState = { nodeCount: 0 };
  return walkNode(v, 0, state);
}

/** Wrap a legacy plain string into a minimal single-paragraph doc. Empty or
 * whitespace-only strings become an empty doc (no stray empty paragraph). */
export function stringToDoc(text: string): JSONContent {
  const trimmed = text.trim();
  if (trimmed === "") return { type: DOC_TYPE, content: [] };
  // Preserve blank-line-separated paragraphs from the legacy textarea era.
  const paragraphs = text.split(/\n{2,}/).map((block) => block.trim());
  return {
    type: DOC_TYPE,
    content: paragraphs
      .filter((p) => p.length > 0)
      .map((p) => ({
        type: "paragraph",
        content: [{ type: "text", text: p }],
      })),
  };
}

/**
 * Normalise any incoming richtext value into a Tiptap doc:
 * - undefined/null → empty doc
 * - string → paragraph doc (legacy upgrade)
 * - doc object → returned as-is
 * Anything else → empty doc (defensive; never throws).
 */
export function toDoc(value: unknown): JSONContent {
  if (value === undefined || value === null) return { type: DOC_TYPE, content: [] };
  if (typeof value === "string") return stringToDoc(value);
  if (isTiptapDoc(value)) return value;
  return { type: DOC_TYPE, content: [] };
}

/** An empty doc has no content nodes (used to skip render/store). */
export function isEmptyDoc(doc: JSONContent): boolean {
  return !doc.content || doc.content.length === 0;
}

/**
 * Extract plain text from a richtext value (doc | legacy string | undefined)
 * for list-card excerpts and admin table cells. Walks the doc, joins text nodes
 * with spacing, collapses whitespace, and truncates. No markup — pure string.
 * Lives here (not richtext-render.tsx) so JSX-free callers (field-utils,
 * content-provider) don't pull the React renderer into their bundle.
 */
export function richtextToPlainText(value: unknown, max = 160): string {
  const doc = toDoc(value);
  const parts: string[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type === "text" && typeof node.text === "string") parts.push(node.text);
    if (node.content) node.content.forEach(walk);
  };
  if (doc.content) doc.content.forEach(walk);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
