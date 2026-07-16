"use client";

import { useCallback, useRef, useState } from "react";
import { UploadCloudIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import type { StoredFileDTO } from "./media-utils";

// Task #7 §2: dropzone + file input, reusing the C.5b upload endpoint
// (POST /api/media/upload) and the same drag/drop affordance pattern as
// MediaPickerDialog's UploadPane — extended here to report per-file progress
// text (no kit spinner) since the full library allows multi-file drops.

interface MediaUploadZoneProps {
  onUploaded: (file: StoredFileDTO) => void;
}

interface QueueState {
  total: number;
  done: number;
}

export function MediaUploadZone({ onUploaded }: MediaUploadZoneProps) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadOne = useCallback(
    async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/media/upload", {
        method: "POST",
        body,
        headers: { "x-requested-with": "fetch" },
      });
      if (!res.ok) {
        throw new Error(res.status === 413 ? "too_large" : "upload_failed");
      }
      const data = (await res.json()) as StoredFileDTO;
      onUploaded(data);
    },
    [onUploaded],
  );

  const uploadMany = useCallback(
    async (list: File[]) => {
      if (list.length === 0) return;
      setError(null);
      setQueue({ total: list.length, done: 0 });
      let failures = 0;
      for (const file of list) {
        try {
          await uploadOne(file);
        } catch {
          failures += 1;
        } finally {
          setQueue((q) => (q ? { ...q, done: q.done + 1 } : q));
        }
      }
      setQueue(null);
      if (failures > 0) {
        setError(
          failures === list.length
            ? t("mediaUpload.uploadFailed")
            : t("mediaUpload.someFailed", { failed: failures, total: list.length }),
        );
      }
    },
    [uploadOne, t],
  );

  const uploading = queue !== null;

  return (
    <div className="flex flex-col gap-2">
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
          void uploadMany(Array.from(e.dataTransfer.files ?? []));
        }}
        disabled={uploading}
        className={cn(
          "flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-[14px] bg-white px-6 py-7 text-center outline-none transition-[box-shadow,background-color] duration-150 ease-out",
          "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]",
          "focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)]",
          dragging
            ? "bg-[rgba(86,114,228,0.04)] shadow-[0_0_0_2px_rgb(86,114,228)]"
            : "hover:bg-black/[0.02]",
          uploading && "opacity-70",
        )}
      >
        <UploadCloudIcon className="size-6 text-black/35" />
        <span className="text-[13px] font-medium text-black/85">
          {uploading
            ? t("mediaUpload.progress", { done: queue.done, total: queue.total })
            : t("mediaUpload.dropHint")}
        </span>
        <span className="text-[11px] text-black/35">
          {t("mediaUpload.hint")}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          void uploadMany(list);
          e.target.value = "";
        }}
      />
      {error && <p className="text-[12px] text-red-700">{error}</p>}
    </div>
  );
}
