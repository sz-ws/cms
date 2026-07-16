"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { richtextExtensions } from "./richtext-extensions";
import { toDoc } from "./richtext-schema";
import { RichtextToolbar } from "./RichtextToolbar";
import { MediaPickerDialog } from "./MediaPickerDialog";

// C.5b §1: the actual Tiptap editor. Loaded via next/dynamic (ssr:false) from
// RichtextField so this chunk — Tiptap + ProseMirror — never ships to public
// pages or non-richtext admin forms. Emits value = Tiptap JSON doc (getJSON()),
// debounced. Accepts an initial value that may be undefined, a legacy string,
// or a JSON doc (normalised via toDoc). Image insert opens the shared media
// picker and inserts <img src="/api/files/<key>">.

const DEBOUNCE_MS = 300;

export interface RichtextEditorProps {
  value: unknown;
  onChange: (doc: JSONContent) => void;
  disabled?: boolean;
  invalid?: boolean;
  fieldKey: string;
}

export default function RichtextEditor({
  value,
  onChange,
  disabled,
  invalid,
  fieldKey,
}: RichtextEditorProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest onChange without re-creating the editor (updated in effect,
  // never during render).
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const emit = useCallback((doc: JSONContent) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChangeRef.current(doc), DEBOUNCE_MS);
  }, []);

  const editor = useEditor({
    // Next.js SSR guard (Tiptap requirement): render only on the client.
    immediatelyRender: false,
    editable: !disabled,
    extensions: richtextExtensions(),
    content: toDoc(value),
    editorProps: {
      attributes: {
        id: `field-${fieldKey}`,
        class:
          "tiptap prose-editor min-h-40 max-w-none px-4 py-3 text-[14px] leading-relaxed text-black/85 outline-none",
        "aria-invalid": invalid ? "true" : "false",
      },
    },
    onUpdate: ({ editor: ed }) => emit(ed.getJSON()),
  });

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Reflect the disabled prop onto the live editor instance.
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const insertImage = useCallback(
    (key: string) => {
      if (!editor || key.trim() === "") return;
      editor
        .chain()
        .focus()
        .setImage({ src: `/api/files/${key.trim()}` })
        .run();
    },
    [editor],
  );

  if (!editor) {
    return (
      <div className="min-h-52 rounded-[10px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)]" />
    );
  }

  return (
    <div
      className="overflow-hidden rounded-[10px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06)] focus-within:shadow-[0_0_0_1px_rgba(0,0,0,0.14),0_0_0_3px_rgba(86,114,228,0.15)]"
      data-invalid={invalid ? "true" : undefined}
    >
      <RichtextToolbar
        editor={editor}
        disabled={disabled}
        onPickImage={() => setPickerOpen(true)}
      />
      <EditorContent editor={editor} />
      <MediaPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={insertImage}
      />
    </div>
  );
}
