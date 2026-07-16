"use client";

import type { Editor } from "@tiptap/react";
import {
  BoldIcon,
  ItalicIcon,
  StrikethroughIcon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  LinkIcon,
  Link2OffIcon,
  ImageIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// C.5b §1: richtext toolbar. Icon buttons, 40px hit areas, active mark rendered
// in dither-blue, white surface + shadow-ring (Paper & Ink). Purely a view over
// the Tiptap editor commands; the editor owns state. The image button delegates
// to the parent (which opens the shared MediaPickerDialog) via onPickImage.

export interface RichtextToolbarProps {
  editor: Editor;
  onPickImage: () => void;
  disabled?: boolean;
}

interface ToolButtonProps {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}

function ToolButton({ onClick, active, disabled, label, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-10 place-items-center rounded-[8px] outline-none transition-[background-color,color,box-shadow] active:scale-[0.96] disabled:opacity-40 motion-reduce:active:scale-100",
        "focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)]",
        active
          ? "bg-[rgba(86,114,228,0.1)] text-[rgb(86,114,228)] shadow-[0_0_0_1px_rgba(86,114,228,0.25)]"
          : "text-black/55 hover:bg-black/[0.04] hover:text-black/85",
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-6 w-px self-center bg-black/10" />;
}

export function RichtextToolbar({ editor, onPickImage, disabled }: RichtextToolbarProps) {
  function toggleLink() {
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const prev = (editor.getAttributes("link").href as string | undefined) ?? "";
    const url = window.prompt("Link URL", prev);
    if (url === null) return; // cancelled
    if (url.trim() === "") {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: url.trim() })
      .run();
  }

  const iconCls = "size-4";

  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-t-[13px] bg-white px-2 py-1.5 shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.06)]">
      <ToolButton
        label="Bold"
        disabled={disabled}
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <BoldIcon className={iconCls} />
      </ToolButton>
      <ToolButton
        label="Italic"
        disabled={disabled}
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <ItalicIcon className={iconCls} />
      </ToolButton>
      <ToolButton
        label="Strikethrough"
        disabled={disabled}
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <StrikethroughIcon className={iconCls} />
      </ToolButton>

      <Divider />

      <ToolButton
        label="Heading 2"
        disabled={disabled}
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2Icon className={iconCls} />
      </ToolButton>
      <ToolButton
        label="Heading 3"
        disabled={disabled}
        active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <Heading3Icon className={iconCls} />
      </ToolButton>

      <Divider />

      <ToolButton
        label="Bullet list"
        disabled={disabled}
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <ListIcon className={iconCls} />
      </ToolButton>
      <ToolButton
        label="Ordered list"
        disabled={disabled}
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrderedIcon className={iconCls} />
      </ToolButton>
      <ToolButton
        label="Blockquote"
        disabled={disabled}
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <QuoteIcon className={iconCls} />
      </ToolButton>

      <Divider />

      <ToolButton
        label={editor.isActive("link") ? "Remove link" : "Add link"}
        disabled={disabled}
        active={editor.isActive("link")}
        onClick={toggleLink}
      >
        {editor.isActive("link") ? (
          <Link2OffIcon className={iconCls} />
        ) : (
          <LinkIcon className={iconCls} />
        )}
      </ToolButton>
      <ToolButton label="Insert image" disabled={disabled} onClick={onPickImage}>
        <ImageIcon className={iconCls} />
      </ToolButton>
    </div>
  );
}
