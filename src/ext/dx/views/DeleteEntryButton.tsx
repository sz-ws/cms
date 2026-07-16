"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/legacy";

interface DeleteEntryButtonProps {
  extId: string;
  typeName: string; // local content type name
  id: string;
}

// 通用刪除按鈕。呼叫 auto-CRUD DELETE /api/ext/<extId>/<typeName>/:id。
export function DeleteEntryButton({
  extId,
  typeName,
  id,
}: DeleteEntryButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    if (!confirm("Delete this entry?")) return;
    setError(null);
    setPending(true);
    try {
      const res = await fetch(
        `/api/ext/${extId}/${typeName}/${encodeURIComponent(id)}`,
        { method: "DELETE", headers: { "Content-Type": "application/json" } },
      );
      if (res.ok) {
        router.refresh();
      } else {
        setError("Delete failed.");
      }
    } catch {
      setError("Network error.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button variant="danger" disabled={pending} onClick={onDelete}>
        {pending ? "…" : "Delete"}
      </Button>
    </div>
  );
}
