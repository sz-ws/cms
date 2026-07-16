"use client";

import { useCallback, useMemo, useState } from "react";
import { MediaUploadZone } from "./MediaUploadZone";
import { MediaToolbar } from "./MediaToolbar";
import { MediaGrid } from "./MediaGrid";
import { MediaEmpty } from "./MediaEmpty";
import { matchesQuery, type StoredFileDTO } from "./media-utils";
import { useT } from "@/lib/i18n/I18nProvider";

// Task #7 §2: the /admin/media library shell. Reuses the C.5b list/upload
// endpoints as-is (GET /api/media/list cursor pagination, POST
// /api/media/upload) and adds the missing delete via POST /api/media/delete.
// State lives entirely client-side: pages already fetched are kept in
// `files`, the R2 cursor drives "Load more", and search/selection operate on
// the loaded set (server-side search would require extending list — noted in
// the toolbar copy and in the task report, not implemented here).

interface MediaLibraryProps {
  initialFiles: StoredFileDTO[];
  initialCursor?: string;
}

export function MediaLibrary({ initialFiles, initialCursor }: MediaLibraryProps) {
  const t = useT();
  const [files, setFiles] = useState<StoredFileDTO[]>(initialFiles);
  const [cursor, setCursor] = useState<string | undefined>(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () => files.filter((f) => matchesQuery(f, query)),
    [files, query],
  );

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await fetch(`/api/media/list?cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) {
        setError(t("mediaLibrary.loadFailed"));
        return;
      }
      const data = (await res.json()) as { files: StoredFileDTO[]; cursor?: string };
      setFiles((prev) => [...prev, ...data.files]);
      setCursor(data.cursor);
    } catch {
      setError(t("mediaLibrary.networkError"));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, t]);

  const handleUploaded = useCallback((file: StoredFileDTO) => {
    // Newest-first so the just-uploaded asset is immediately visible without a refetch.
    setFiles((prev) => [file, ...prev.filter((f) => f.key !== file.key)]);
  }, []);

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const deleteSelected = useCallback(async () => {
    const keys = Array.from(selected);
    if (keys.length === 0) return;
    setDeleting(true);
    setError(null);
    try {
      const results = await Promise.all(
        keys.map((key) =>
          fetch("/api/media/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key }),
          }),
        ),
      );
      const failed = results.filter((r) => !r.ok).length;
      const okKeys = new Set(
        keys.filter((_, i) => results[i].ok),
      );
      setFiles((prev) => prev.filter((f) => !okKeys.has(f.key)));
      setSelected(new Set());
      if (failed > 0) {
        setError(
          failed === keys.length
            ? t("mediaLibrary.deleteFailed")
            : t("mediaLibrary.someDeletesFailed", { failed, total: keys.length }),
        );
      }
    } catch {
      setError(t("mediaLibrary.networkError"));
    } finally {
      setDeleting(false);
    }
  }, [selected, t]);

  return (
    <div className="flex flex-col gap-5">
      <MediaUploadZone onUploaded={handleUploaded} />

      {error && <p className="text-[12px] text-red-700">{error}</p>}

      <MediaToolbar
        query={query}
        onQueryChange={setQuery}
        total={visible.length}
        selectedKeys={Array.from(selected)}
        onClearSelection={clearSelection}
        onDelete={deleteSelected}
        deleting={deleting}
      />

      {visible.length === 0 ? (
        <MediaEmpty filtered={query.trim().length > 0} onClearFilter={() => setQuery("")} />
      ) : (
        <MediaGrid files={visible} selected={selected} onToggle={toggleSelect} />
      )}

      {cursor && query.trim().length === 0 && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mx-auto inline-flex h-10 items-center rounded-[8px] bg-white px-4 text-[13px] font-medium text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] transition-[background-color,transform] active:scale-[0.96] hover:bg-black/[0.03] disabled:opacity-50"
        >
          {loadingMore ? t("mediaLibrary.loading") : t("mediaLibrary.loadMore")}
        </button>
      )}
    </div>
  );
}
