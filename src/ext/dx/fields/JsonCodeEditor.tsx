"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";

// Raw CodeMirror 6 (no @uiw wrapper) kept intentionally thin: this file is
// dynamically imported (see JsonField.tsx) so its ~40kb+ of editor code never
// reaches the public bundle, only the admin form page that actually renders
// a json field.

export interface JsonCodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  onBlur: () => void;
  disabled?: boolean;
}

export default function JsonCodeEditor({
  value,
  onChange,
  onBlur,
  disabled,
}: JsonCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
  });

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        json(),
        EditorView.editable.of(!disabled),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.domEventHandlers({
          blur: () => {
            onBlurRef.current();
            return false;
          },
        }),
        EditorView.theme({
          "&": {
            fontSize: "13px",
            borderRadius: "1rem",
          },
          ".cm-content": {
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            padding: "0.75rem",
          },
          ".cm-gutters": {
            borderRadius: "1rem 0 0 1rem",
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Editor is created once; external `value` resets are handled by
    // remounting this component (see `key` usage in JsonField.tsx) rather
    // than reconciling doc state here, keeping this effect dependency-free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={hostRef}
      className="overflow-hidden rounded-2xl border border-input/60 bg-input/30 [&_.cm-editor]:rounded-2xl [&_.cm-editor.cm-focused]:outline-none"
    />
  );
}
