"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, UploadCloudIcon, FileIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// C.5b §2: reusable media picker. Two tabs — Upload (dropzone → POST
// /api/media/upload) and Library (grid from GET /api/media/list). Selecting in
// either tab calls onSelect(key) and closes. Used by MediaField AND by
// RichtextField's image button. Base-ui Dialog gives the focus trap + Escape
// close + backdrop for free; we follow the Paper & Ink language (white surface,
// concentric radii, dither-blue selection ring, 40px hit areas).

export interface MediaPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (key: string) => void;
}

interface StoredFileDTO {
  key: string;
  size: number;
  contentType: string;
}

const IMAGE_CT_RE = /^image\//;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)$/i;

function isImage(file: StoredFileDTO): boolean {
  return IMAGE_CT_RE.test(file.contentType) || IMAGE_EXT_RE.test(file.key);
}

// Phase E §10: narrow the two res.json() payloads at runtime instead of a bare
// `as` cast — mirrors the guard style in dx/fields/relation-options.ts
// (parseOptions). A malformed/unexpected response degrades gracefully (empty
// list / no selection) within the existing try/catch, rather than trusting an
// unchecked cast that could blow up downstream spreads/maps.

function isStoredFileDTO(v: unknown): v is StoredFileDTO {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { key?: unknown }).key === "string" &&
    typeof (v as { size?: unknown }).size === "number" &&
    typeof (v as { contentType?: unknown }).contentType === "string"
  );
}

/** Narrow the GET /api/media/list payload; unknown shape → empty list. */
function parseListResponse(json: unknown): {
  files: StoredFileDTO[];
  cursor?: string;
} {
  if (typeof json !== "object" || json === null) return { files: [] };
  const raw = (json as { files?: unknown }).files;
  const files = Array.isArray(raw) ? raw.filter(isStoredFileDTO) : [];
  const cursor = (json as { cursor?: unknown }).cursor;
  return { files, cursor: typeof cursor === "string" ? cursor : undefined };
}

/** Narrow the POST /api/media/upload payload; unknown shape → null (no-op). */
function parseUploadResponse(json: unknown): { key: string } | null {
  if (typeof json !== "object" || json === null) return null;
  const key = (json as { key?: unknown }).key;
  return typeof key === "string" ? { key } : null;
}

export function MediaPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: MediaPickerDialogProps) {
  const [tab, setTab] = useState<"library" | "upload">("library");

  const handleSelect = useCallback(
    (key: string) => {
      onSelect(key);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl rounded-[20px] p-0 shadow-[0_16px_48px_-12px_rgba(30,20,50,0.18)] sm:max-w-2xl">
        <div className="flex flex-col gap-4 p-5">
          <DialogHeader>
            <DialogTitle>Choose media</DialogTitle>
            <DialogDescription>
              Upload a new file or pick one from your library.
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v === "upload" ? "upload" : "library")}
          >
            <TabsList className="rounded-[10px] bg-black/[0.04] p-1">
              <TabsTrigger value="library" className="rounded-[8px] text-[13px]">
                Library
              </TabsTrigger>
              <TabsTrigger value="upload" className="rounded-[8px] text-[13px]">
                Upload
              </TabsTrigger>
            </TabsList>

            <TabsContent value="library" className="mt-4">
              <LibraryGrid onSelect={handleSelect} active={open && tab === "library"} />
            </TabsContent>
            <TabsContent value="upload" className="mt-4">
              <UploadPane onUploaded={handleSelect} />
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Library tab ----

function LibraryGrid({
  onSelect,
  active,
}: {
  onSelect: (key: string) => void;
  active: boolean;
}) {
  const [files, setFiles] = useState<StoredFileDTO[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : "";
      const res = await fetch(`/api/media/list${qs}`);
      if (!res.ok) {
        setError("Could not load library.");
        return;
      }
      const data = parseListResponse(await res.json());
      setFiles((prev) => (nextCursor ? [...prev, ...data.files] : data.files));
      setCursor(data.cursor);
      setLoaded(true);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load once when the tab first becomes active. Deferred to a task so the
  // effect body itself performs no synchronous setState (react-hooks lint).
  useEffect(() => {
    if (!active || loaded || loading) return;
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [active, loaded, loading, load]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <p className="text-[13px] text-black/55">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="h-10 rounded-[8px] px-3 text-[13px] font-medium text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] transition-[background-color] hover:bg-black/[0.03] active:scale-[0.96]"
        >
          Retry
        </button>
      </div>
    );
  }

  if (loaded && files.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-12 text-center">
        <span className="grid size-3 place-items-center rounded-full ring-1 ring-black/25">
          <span className="size-1 rounded-full bg-black/25" />
        </span>
        <p className="text-[13px] text-black/45">
          Nothing uploaded yet. Use the Upload tab.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="grid max-h-[46vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
        {files.map((file) => (
          <li key={file.key}>
            <button
              type="button"
              onClick={() => onSelect(file.key)}
              title={file.key}
              className="group relative flex aspect-square w-full flex-col items-center justify-center overflow-hidden rounded-[10px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] outline-none transition-[box-shadow] focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.1),0_2px_6px_-2px_rgba(0,0,0,0.12)] active:scale-[0.96] motion-reduce:active:scale-100"
            >
              {isImage(file) ? (
                // Storage-key preview: /api/files/<key>. next/image would need a
                // loader for this dynamic source; native img is intentional.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/files/${file.key}`}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover"
                />
              ) : (
                <span className="flex flex-col items-center gap-1 px-1 text-center">
                  <FileIcon className="size-5 text-black/35" />
                  <span className="w-full truncate font-mono text-[10px] lowercase text-black/45">
                    {file.key.split("/").pop()}
                  </span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          type="button"
          onClick={() => void load(cursor)}
          disabled={loading}
          className="mx-auto h-10 rounded-[8px] px-4 text-[13px] font-medium text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] transition-[background-color] hover:bg-black/[0.03] active:scale-[0.96] disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

// ---- Upload tab ----

function UploadPane({ onUploaded }: { onUploaded: (key: string) => void }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(null);
      try {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/media/upload", {
          method: "POST",
          body,
          headers: { "x-requested-with": "fetch" },
        });
        if (!res.ok) {
          setError(res.status === 413 ? "File is too large (max 25MB)." : "Upload failed.");
          return;
        }
        const data = parseUploadResponse(await res.json());
        if (!data) {
          setError("Upload failed.");
          return;
        }
        onUploaded(data.key);
      } catch {
        setError("Network error.");
      } finally {
        setUploading(false);
      }
    },
    [onUploaded],
  );

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void upload(file);
        }}
        disabled={uploading}
        className={cn(
          "flex min-h-40 flex-col items-center justify-center gap-2 rounded-[14px] bg-white px-6 py-8 text-center outline-none transition-[box-shadow,background-color]",
          "shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06)]",
          "focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)]",
          dragging
            ? "bg-[rgba(86,114,228,0.04)] shadow-[0_0_0_2px_rgba(86,114,228,0.5)]"
            : "hover:bg-black/[0.02]",
          uploading && "opacity-70",
        )}
      >
        <UploadCloudIcon className="size-6 text-black/35" />
        <span className="text-[13px] font-medium text-black/85">
          {uploading ? "Uploading…" : "Drop a file or click to browse"}
        </span>
        <span className="text-[11px] text-black/35">Images, video, audio, PDF · up to 25MB</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />
      {error && (
        <p className="flex items-center gap-1.5 text-[12px] text-red-700">
          <ImageIcon className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
