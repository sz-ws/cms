// Phase E §2: shared media-key shape check. Mirrors the `isManagedKey`/`KEY_RE`
// pair in src/app/api/media/delete/route.ts (NOT imported from there — that
// route is owned by a concurrent change; this is a deliberate, documented
// duplicate so both call sites stay decoupled). Key shape produced by
// lib/storage.ts#makeKey: "<scope>/<yyyy>/<mm>/<nanoid>.<ext>". scope = "core"
// or an extension id: lowercase alnum + dot/dash/underscore.
//
// Used at TWO points (defense-in-depth, core-v2 §5):
//   - write time: content-provider.ts validateField `case "media"` rejects any
//     value that isn't a well-formed managed key.
//   - render time: DetailView.tsx / structural-render.tsx refuse to emit an
//     <img src="/api/files/<value>"> unless the value passes this check (so a
//     hand-edited/legacy DB row can never produce an unsafe src attribute).
const KEY_RE = /^[a-z0-9._-]+\/\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.[a-z0-9]{1,8}$/;

/** Reject anything that isn't exactly the managed key shape — no traversal,
 * no absolute paths, no reaching outside the yyyy/mm scoped prefixes. */
export function isMediaKey(value: string): boolean {
  if (value.includes("..") || value.startsWith("/")) return false;
  return KEY_RE.test(value);
}
