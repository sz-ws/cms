import { Fragment, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/core";
import { toDoc, isEmptyDoc } from "../fields/richtext-schema";

// C.5b §3: SAFE public rendering of richtext Tiptap JSON.
//
// Security posture (Phase E reviewed): we do NOT use dangerouslySetInnerHTML and
// do NOT ship an HTML string at all. Instead we walk the Tiptap JSON and emit
// React elements for a CLOSED allowlist of node/mark types that matches
// richtext-extensions.ts. Any unknown node type is dropped; any unknown mark is
// ignored. Text content is rendered as plain React text (auto-escaped by React),
// so no markup can be injected via the stored JSON.
//
// Links: only http(s)/mailto hrefs are honoured; anything else (javascript:,
// data:, relative) is rendered as plain text with no href. rel/target are
// forced. Images: src must resolve to our own /api/files/<key> path — any other
// src is dropped (no arbitrary remote/tracking images, no data: URIs).

const ALLOWED_LINK_PROTO = /^(https?:|mailto:)/i;
const ALLOWED_IMG_SRC = /^\/api\/files\/[^\s"'<>]+$/;

type Mark = { type?: string; attrs?: Record<string, unknown> };

/** True when href is a safe, absolute http(s)/mailto URL. */
function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  return ALLOWED_LINK_PROTO.test(trimmed) ? trimmed : null;
}

/** Wrap a text run in its allowed marks (bold/italic/strike/code/link). */
function applyMarks(text: string, marks: Mark[] | undefined, keyBase: string): ReactNode {
  if (!marks || marks.length === 0) return text;
  return marks.reduce<ReactNode>((acc, mark, i) => {
    const k = `${keyBase}-m${i}`;
    switch (mark.type) {
      case "bold":
        return <strong key={k}>{acc}</strong>;
      case "italic":
        return <em key={k}>{acc}</em>;
      case "strike":
        return <s key={k}>{acc}</s>;
      case "code":
        return <code key={k}>{acc}</code>;
      case "link": {
        const href = safeHref(mark.attrs?.href);
        if (!href) return acc; // unsafe href → plain text, no anchor
        return (
          <a key={k} href={href} rel="noopener noreferrer nofollow" target="_blank">
            {acc}
          </a>
        );
      }
      default:
        return acc; // unknown mark → ignored
    }
  }, text);
}

function renderInline(nodes: JSONContent[] | undefined, keyBase: string): ReactNode {
  if (!nodes) return null;
  return nodes.map((node, i) => {
    const k = `${keyBase}-i${i}`;
    if (node.type === "text") {
      return (
        <Fragment key={k}>{applyMarks(node.text ?? "", node.marks as Mark[], k)}</Fragment>
      );
    }
    if (node.type === "hardBreak") return <br key={k} />;
    return null; // only text/hardBreak are valid inline nodes
  });
}

function renderBlock(node: JSONContent, key: string): ReactNode {
  switch (node.type) {
    case "paragraph":
      return <p key={key}>{renderInline(node.content, key)}</p>;
    case "heading": {
      const level = Number(node.attrs?.level);
      const inner = renderInline(node.content, key);
      // Only h2/h3 exist in our schema (h1 is the page title).
      return level === 3 ? <h3 key={key}>{inner}</h3> : <h2 key={key}>{inner}</h2>;
    }
    case "bulletList":
      return <ul key={key}>{renderList(node.content, key)}</ul>;
    case "orderedList":
      return <ol key={key}>{renderList(node.content, key)}</ol>;
    case "blockquote":
      return <blockquote key={key}>{renderNodes(node.content, key)}</blockquote>;
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{renderInline(node.content, key)}</code>
        </pre>
      );
    case "horizontalRule":
      return <hr key={key} />;
    case "image": {
      const src = node.attrs?.src;
      // Phase E §12: belt-and-suspenders — don't rely solely on the
      // downstream /api/files/<key> route to reject traversal; refuse any
      // src containing ".." here too, even though ALLOWED_IMG_SRC's
      // no-slash-after-prefix shape already makes a traversal segment hard
      // to construct.
      if (
        typeof src !== "string" ||
        !ALLOWED_IMG_SRC.test(src) ||
        src.includes("..")
      )
        return null;
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      // eslint-disable-next-line @next/next/no-img-element -- dynamic storage-key source resolved to /api/files/<key>.
      return <img key={key} src={src} alt={alt} className="max-w-full rounded" />;
    }
    default:
      return null; // unknown block type → dropped
  }
}

function renderList(items: JSONContent[] | undefined, keyBase: string): ReactNode {
  if (!items) return null;
  return items.map((item, i) => {
    const k = `${keyBase}-li${i}`;
    if (item.type !== "listItem") return null;
    return <li key={k}>{renderNodes(item.content, k)}</li>;
  });
}

function renderNodes(nodes: JSONContent[] | undefined, keyBase: string): ReactNode {
  if (!nodes) return null;
  return nodes.map((node, i) => renderBlock(node, `${keyBase}-b${i}`));
}

/**
 * Render a richtext value (Tiptap doc, legacy string, or undefined) to safe
 * React elements. Returns null for empty content so callers can skip the field.
 */
export function renderRichtext(value: unknown): ReactNode {
  const doc = toDoc(value);
  if (isEmptyDoc(doc)) return null;
  return renderNodes(doc.content, "rt");
}

// richtextToPlainText lives in ../fields/richtext-schema (JSX-free) so non-React
// callers can use it without pulling this renderer in. Re-exported for callers
// that already import from this module.
export { richtextToPlainText } from "../fields/richtext-schema";
