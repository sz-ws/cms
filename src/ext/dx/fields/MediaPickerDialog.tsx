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
import { MediaImage } from "@/components/ui/media-image";
import { cn } from "@/lib/utils";
import type { MessageKey } from "@/lib/i18n/index";
import { useExtT } from "../ext-locale";

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
  /**
   * 1.66.0:一次挑多張圖(gallery 欄位用)。給了它就是多選:媒體庫只列圖片,點一下勾選、
   * 照點的順序編號,按「加入 N 張」交回;上傳可以一次選多個檔,傳完連同已勾的一起交回。
   * 多選時不會呼叫 onSelect。
   */
  onSelectMany?: (keys: string[]) => void;
  /** 多選時最多還能挑幾張(沒給 = 不限)。 */
  limit?: number;
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
  onSelectMany,
  limit,
}: MediaPickerDialogProps) {
  const [tab, setTab] = useState<"library" | "upload">("library");
  const [picked, setPicked] = useState<string[]>([]);
  const t = useExtT();
  const many = onSelectMany !== undefined;
  const cap = limit ?? Number.POSITIVE_INFINITY;

  // 關掉就清掉勾選,下次打開從頭挑。
  const changeOpen = useCallback(
    (next: boolean) => {
      if (!next) setPicked([]);
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const handleSelect = useCallback(
    (key: string) => {
      onSelect(key);
      changeOpen(false);
    },
    [onSelect, changeOpen],
  );

  const toggle = useCallback(
    (key: string) =>
      setPicked((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : prev.length >= cap ? prev : [...prev, key],
      ),
    [cap],
  );

  // 上傳完:單選直接交回那一張;多選連同已勾的一起交回。有檔案失敗時(done=false)先交回
  // 傳好的,對話框留著顯示錯誤。
  const handleUploaded = useCallback(
    (keys: string[], done: boolean) => {
      if (!many) {
        if (keys[0]) handleSelect(keys[0]);
        return;
      }
      const all = [...picked, ...keys];
      if (keys.length > 0) {
        onSelectMany(all);
        setPicked([]);
      }
      if (done) changeOpen(false);
    },
    [many, picked, onSelectMany, handleSelect, changeOpen],
  );

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-2xl rounded-[20px] admin:rounded-[calc(20px*var(--admin-radius-scale,1))] p-0 shadow-[0_16px_48px_-12px_rgba(30,20,50,0.18)] admin:shadow-[var(--admin-shadow-panel,0_16px_48px_-12px_rgba(30,20,50,0.18))] sm:max-w-2xl">
        <div className="flex flex-col gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{t(many ? "mediaPicker.titleMany" : "mediaPicker.title")}</DialogTitle>
            <DialogDescription>{t(many ? "mediaPicker.descMany" : "mediaPicker.desc")}</DialogDescription>
          </DialogHeader>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v === "upload" ? "upload" : "library")}
          >
            <TabsList className="rounded-[10px] admin:rounded-[calc(10px*var(--admin-radius-scale,1))] bg-black/[0.04] admin:bg-ink/[0.04] p-1">
              <TabsTrigger value="library" className="rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] text-[13px]">
                {t("mediaPicker.library")}
              </TabsTrigger>
              <TabsTrigger value="upload" className="rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] text-[13px]">
                {t("mediaPicker.upload")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="library" className="mt-4">
              <LibraryGrid
                onSelect={many ? toggle : handleSelect}
                picked={many ? picked : undefined}
                active={open && tab === "library"}
              />
            </TabsContent>
            <TabsContent value="upload" className="mt-4">
              <UploadPane
                multiple={many}
                room={many ? cap - picked.length : 1}
                onUploaded={handleUploaded}
              />
            </TabsContent>
          </Tabs>

          {many ? (
            <div className="flex items-center justify-end gap-3">
              {picked.length >= cap ? (
                <span className="text-[12px] text-black/45 admin:text-ink/45">
                  {t("mediaPicker.full")}
                </span>
              ) : null}
              <button
                type="button"
                disabled={picked.length === 0}
                onClick={() => {
                  onSelectMany(picked);
                  changeOpen(false);
                }}
                className="inline-flex h-10 items-center rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] bg-black admin:bg-ink px-4 text-[13px] font-medium text-white transition-[background-color] outline-none hover:bg-black/85 admin:hover:bg-ink/85 focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.25)] active:scale-[0.96] disabled:opacity-40 motion-reduce:active:scale-100"
              >
                {t("mediaPicker.addMany", { n: picked.length })}
              </button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Library tab ----

function LibraryGrid({
  onSelect,
  picked,
  active,
}: {
  onSelect: (key: string) => void;
  /** 多選時目前勾了哪些(照順序);單選不給。多選只列圖片。 */
  picked?: readonly string[];
  active: boolean;
}) {
  const [files, setFiles] = useState<StoredFileDTO[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  // 存字典 key 而不是翻好的字:load 不必依賴 t。
  const [error, setError] = useState<MessageKey | null>(null);
  const [loaded, setLoaded] = useState(false);
  const t = useExtT();

  const load = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : "";
      const res = await fetch(`/api/media/list${qs}`);
      if (!res.ok) {
        setError("mediaPicker.loadFailed");
        return;
      }
      const data = parseListResponse(await res.json());
      setFiles((prev) => (nextCursor ? [...prev, ...data.files] : data.files));
      setCursor(data.cursor);
      setLoaded(true);
    } catch {
      setError("mediaPicker.networkError");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load once when the tab first becomes active. Deferred to a task so the
  // effect body itself performs no synchronous setState (react-hooks lint).
  useEffect(() => {
    if (!active || loaded || loading) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [active, loaded, loading, load]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <p className="text-[13px] text-black/55 admin:text-ink/55">{t(error)}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="h-10 rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 text-[13px] font-medium text-black/85 admin:text-ink/85 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06))] transition-[background-color] hover:bg-black/[0.03] admin:hover:bg-ink/[0.03] active:scale-[0.96]"
        >
          {t("mediaPicker.retry")}
        </button>
      </div>
    );
  }

  const shown = picked ? files.filter(isImage) : files;

  if (loaded && shown.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-12 text-center">
        <span className="grid size-3 place-items-center rounded-full ring-1 ring-black/25 admin:ring-ink/25">
          <span className="size-1 rounded-full bg-black/25 admin:bg-ink/25" />
        </span>
        <p className="text-[13px] text-black/45 admin:text-ink/45">
          {t("mediaPicker.empty")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="grid max-h-[46vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
        {shown.map((file) => {
          const order = picked ? picked.indexOf(file.key) + 1 : 0;
          return (
          <li key={file.key}>
            <button
              type="button"
              onClick={() => onSelect(file.key)}
              title={file.key}
              aria-pressed={picked ? order > 0 : undefined}
              className="group relative flex aspect-square w-full flex-col items-center justify-center overflow-hidden rounded-[10px] admin:rounded-[calc(10px*var(--admin-radius-scale,1))] bg-white admin:bg-surface shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06))] outline-none transition-[box-shadow] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--admin-accent)_35%,transparent)] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.1),0_2px_6px_-2px_rgba(0,0,0,0.12)] active:scale-[0.96] motion-reduce:active:scale-100"
            >
              {isImage(file) ? (
                // Storage-key preview through the shared variant helper: the
                // grid is aspect-square thumbnails, so it asks for the small
                // srcset tiers instead of pulling full-size originals.
                <MediaImage
                  mediaKey={file.key}
                  alt=""
                  maxWidth={320}
                  sizes="160px"
                  className="size-full object-cover"
                />
              ) : (
                <span className="flex flex-col items-center gap-1 px-1 text-center">
                  <FileIcon className="size-5 text-black/35 admin:text-ink/35" />
                  <span className="w-full truncate font-mono text-[10px] lowercase text-black/45 admin:text-ink/45">
                    {file.key.split("/").pop()}
                  </span>
                </span>
              )}
              {order > 0 ? (
                // 勾選:外框 + 右上角的順序號碼(加進欄位就是這個順序)。
                <span className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_2px_var(--admin-accent,#000)]">
                  <span className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-(--admin-accent,#000) text-[12px] font-semibold tabular-nums text-white">
                    {order}
                  </span>
                </span>
              ) : null}
            </button>
          </li>
          );
        })}
      </ul>
      {cursor && (
        <button
          type="button"
          onClick={() => void load(cursor)}
          disabled={loading}
          className="mx-auto h-10 rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] px-4 text-[13px] font-medium text-black/85 admin:text-ink/85 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06))] transition-[background-color] hover:bg-black/[0.03] admin:hover:bg-ink/[0.03] active:scale-[0.96] disabled:opacity-50"
        >
          {t(loading ? "mediaPicker.loading" : "mediaPicker.loadMore")}
        </button>
      )}
    </div>
  );
}

// ---- Upload tab ----

type UploadResult = { key: string } | { error: MessageKey };

async function uploadOne(file: File): Promise<UploadResult> {
  try {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/media/upload", {
      method: "POST",
      body,
      headers: { "x-requested-with": "fetch" },
    });
    if (!res.ok) return { error: res.status === 413 ? "mediaPicker.tooLarge" : "mediaPicker.uploadFailed" };
    const data = parseUploadResponse(await res.json());
    return data ?? { error: "mediaPicker.uploadFailed" };
  } catch {
    return { error: "mediaPicker.networkError" };
  }
}

function UploadPane({
  multiple,
  room,
  onUploaded,
}: {
  /** 多選:可以一次選多個檔(只收圖片),一張一張依序上傳。 */
  multiple: boolean;
  /** 最多收幾個檔,多出來的不上傳。 */
  room: number;
  /** 傳好的 key(照選檔順序);done = 全部成功。 */
  onUploaded: (keys: string[], done: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useExtT();
  const uploading = progress !== null;

  const upload = useCallback(
    async (picked: File[]) => {
      const files = picked.slice(0, Math.max(0, room));
      if (files.length === 0) return;
      setError(null);
      const keys: string[] = [];
      let failed: MessageKey | null = null;
      for (const [index, file] of files.entries()) {
        setProgress({ done: index, total: files.length });
        const result = await uploadOne(file);
        if ("error" in result) {
          failed = result.error;
          break;
        }
        keys.push(result.key);
      }
      setProgress(null);
      if (failed) setError(failed);
      onUploaded(keys, failed === null);
    },
    [room, onUploaded],
  );

  const label = progress
    ? progress.total > 1
      ? t("mediaPicker.uploadingMany", { done: progress.done + 1, total: progress.total })
      : t("mediaPicker.uploading")
    : t("mediaPicker.dropHint");

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
          const dropped = Array.from(e.dataTransfer.files ?? []);
          void upload(multiple ? dropped.filter((f) => IMAGE_CT_RE.test(f.type)) : dropped.slice(0, 1));
        }}
        disabled={uploading}
        className={cn(
          "flex min-h-40 flex-col items-center justify-center gap-2 rounded-[14px] admin:rounded-[calc(14px*var(--admin-radius-scale,1))] bg-white admin:bg-surface px-6 py-8 text-center outline-none transition-[box-shadow,background-color]",
          "shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06))]",
          "focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--admin-accent)_35%,transparent)]",
          dragging
            ? "bg-(--admin-accent)/[0.04] shadow-[0_0_0_2px_color-mix(in_srgb,var(--admin-accent)_50%,transparent)]"
            : "hover:bg-black/[0.02] admin:hover:bg-ink/[0.02]",
          uploading && "opacity-70",
        )}
      >
        <UploadCloudIcon className="size-6 text-black/35 admin:text-ink/35" />
        <span className="text-[13px] font-medium text-black/85 admin:text-ink/85">{label}</span>
        <span className="text-[11px] text-black/35 admin:text-ink/35">
          {t(multiple ? "mediaPicker.hintMany" : "mediaPicker.hint")}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={multiple ? "image/*" : undefined}
        className="hidden"
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? []);
          e.target.value = "";
          void upload(chosen);
        }}
      />
      {error && (
        <p className="flex items-center gap-1.5 text-[12px] text-red-700">
          <ImageIcon className="size-3.5" />
          {t(error)}
        </p>
      )}
    </div>
  );
}
