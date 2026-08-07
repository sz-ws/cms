"use client";

import { useState } from "react";
import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useImeGuard } from "@/lib/ime";

// Alt text row for a media card. Sits UNDER the card's selection button (never
// inside it — nested interactive elements inside a <button> are invalid HTML and
// would steal the selection click).
//
// Storage: alt lives in the R2 object's customMetadata; POST /api/media/alt
// re-puts the object with the same body. See src/lib/storage.ts#updateFileAlt.
//
// Visual: inset hairline instead of a border (shadows over borders), 11px
// caption register, 8px controls inside the 14px card, text-based "Saving…"
// rather than a kit spinner — per docs/admin-design-language.md.

/** Mirrors MAX_ALT_LENGTH in src/lib/storage.ts (server truncates/rejects too). */
const MAX_ALT_LENGTH = 500;

interface MediaAltFieldProps {
  alt?: string;
  /** Resolves true on success; false leaves the editor open with an error. */
  onSave: (alt: string) => Promise<boolean>;
}

export function MediaAltField({ alt, onSave }: MediaAltFieldProps) {
  const ime = useImeGuard();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(alt ?? "");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  function startEditing() {
    setDraft(alt ?? "");
    setFailed(false);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setFailed(false);
    setDraft(alt ?? "");
  }

  async function save() {
    if (saving) return;
    const next = draft.trim();
    if (next === (alt ?? "")) {
      cancel();
      return;
    }
    setSaving(true);
    setFailed(false);
    const ok = await onSave(next);
    setSaving(false);
    if (ok) setEditing(false);
    else setFailed(true);
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1 px-1.5 pb-1.5 pt-1.5 shadow-[inset_0_1px_0_rgba(0,0,0,0.06)]">
        <div className="flex min-w-0 items-center gap-1">
          <input
            // Opened by an explicit click, so focus must follow the user's intent.
            autoFocus
            value={draft}
            maxLength={MAX_ALT_LENGTH}
            disabled={saving}
            aria-label="Alt text"
            placeholder="Describe this image"
            onChange={(e) => setDraft(e.target.value)}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(e) => {
              // 組字中的 Enter 是在確定候選字,Esc 是在取消候選(見 @/lib/ime)。
              if (ime.isComposingKey(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            className={cn(
              "h-7 min-w-0 flex-1 rounded-[8px] border-none bg-white px-2 text-[11px] text-black/85 outline-none placeholder:text-black/25",
              "shadow-[0_0_0_1px_rgba(0,0,0,0.08)] transition-[box-shadow] duration-150 ease-out",
              "focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2),0_0_0_3px_rgba(0,0,0,0.05)]",
              "disabled:opacity-60",
            )}
          />
          {saving ? (
            <span className="shrink-0 px-1 text-[11px] text-black/35">Saving…</span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void save()}
                aria-label="Save alt text"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-black/45 transition-[background-color,color,transform] duration-150 ease-out hover:bg-black/[0.03] hover:text-[rgb(86,114,228)] active:scale-[0.94]"
              >
                <CheckIcon className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={cancel}
                aria-label="Cancel"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-black/30 transition-[background-color,color,transform] duration-150 ease-out hover:bg-black/[0.03] hover:text-black/60 active:scale-[0.94]"
              >
                <XIcon className="size-3.5" />
              </button>
            </>
          )}
        </div>
        {failed && (
          <p className="px-1 text-[11px] text-red-700">Could not save alt text</p>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      title={alt ? `Alt text: ${alt}` : "Add alt text"}
      className="group/alt flex min-w-0 items-center gap-1 px-2.5 py-1.5 text-left outline-none shadow-[inset_0_1px_0_rgba(0,0,0,0.06)] transition-colors duration-150 ease-out hover:bg-black/[0.02] focus-visible:bg-black/[0.02]"
    >
      <PencilIcon className="size-3 shrink-0 text-black/20 transition-colors duration-150 ease-out group-hover/alt:text-black/40" />
      <span
        className={cn(
          "min-w-0 truncate text-[11px]",
          alt ? "text-black/45" : "text-black/30",
        )}
      >
        {alt ? alt : "Add alt text"}
      </span>
    </button>
  );
}
