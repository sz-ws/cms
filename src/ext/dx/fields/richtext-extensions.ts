import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import type { Extensions } from "@tiptap/core";

// C.5b §1: the fixed extension set for the CLIENT richtext editor (Tiptap).
//
// Phase E §12 correction: there is NO generateHTML path and no shared renderer
// module. The public renderer (dx/views/richtext-render.tsx) does NOT consume
// this file — it is an independent, hand-rolled JSON→React allowlist walk over
// the stored Tiptap document (no dangerouslySetInnerHTML, no HTML string at
// all; see that file's header comment). This extension list (what the editor
// can PRODUCE) and richtext-render.tsx's allowlist (what the renderer will
// DISPLAY) are TWO SEPARATE, MANUALLY-MAINTAINED lists that happen to describe
// the same node/mark set today. Adding a node or mark here does nothing for
// rendering until richtext-render.tsx's allowlist is updated to match — the two
// must be kept in sync by hand whenever either changes.
//
// StarterKit v2 provides: doc, paragraph, text, bold, italic, strike, code,
// codeBlock, heading, bulletList, orderedList, listItem, blockquote,
// horizontalRule, hardBreak, history, dropcursor, gapcursor. It does NOT bundle
// Link or Image, so we register both explicitly (hardened Link below).

/** Link config shared client+server: only http(s)/mailto, safe rel/target. */
const SAFE_LINK = Link.configure({
  openOnClick: false,
  autolink: true,
  protocols: ["http", "https", "mailto"],
  HTMLAttributes: {
    rel: "noopener noreferrer nofollow",
    target: "_blank",
  },
});

/** Build the extension list. `heading.levels` limited to h2/h3 (h1 is the page
 * title on public pages) to match the toolbar. */
export function richtextExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
    }),
    SAFE_LINK,
    Image.configure({
      inline: false,
      allowBase64: false, // images are R2 keys resolved to /api/files/<key>
    }),
  ];
}
