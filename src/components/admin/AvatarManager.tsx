"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/I18nProvider";

// /admin/account 的頭像管理。後端 = /api/account/avatar(51a329f:2MB cap、
// png/jpeg/webp 白名單、self-only)。成功後 router.refresh() 讓 server 重讀
// SessionUser.avatarKey —— sidebar chip 與本卡同一資料源,一次刷新兩處同步。

interface AvatarManagerProps {
  name: string;
  avatarKey: string | null;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function AvatarManager({ name, avatarKey }: AvatarManagerProps) {
  const t = useT();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = avatarKey ? `/api/files/${avatarKey}` : null;

  function errorText(code: unknown): string {
    if (code === "too_large") return t("account.avatarTooLarge");
    if (code === "invalid_type") return t("account.avatarInvalidType");
    return t("account.avatarError");
  }

  async function onPick(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/account/avatar", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(errorText(j?.error));
        return;
      }
      router.refresh();
    } catch {
      setError(t("account.avatarError"));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function onRemove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/avatar", { method: "DELETE" });
      if (!res.ok) {
        setError(t("account.avatarError"));
        return;
      }
      router.refresh();
    } catch {
      setError(t("account.avatarError"));
    } finally {
      setBusy(false);
    }
  }

  const buttonClasses =
    "inline-flex h-8 items-center rounded-[8px] bg-black/[0.04] px-3 text-[12.5px] font-medium text-black/65 transition-[background-color,transform] duration-150 ease-out hover:bg-black/[0.07] active:scale-[0.96] disabled:opacity-50";

  return (
    <div className="flex items-center gap-4">
      {/* 玻璃質感頭像 tile:與 Browse 的 ExtIcon 同語彙(內光 + ring + sheen)。 */}
      <div className="relative isolate size-16 shrink-0 overflow-hidden rounded-[16px] bg-gradient-to-b from-white/75 to-white/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),inset_0_-1px_2px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.08),0_2px_6px_-2px_rgba(0,0,0,0.14)]">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={name} className="size-full object-cover" />
        ) : (
          <div
            style={{
              backgroundImage: "linear-gradient(135deg,#5672e4,#8a6fe0)",
            }}
            className="flex size-full items-center justify-center text-[20px] font-semibold text-white"
          >
            {initialsOf(name)}
          </div>
        )}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/30 via-white/0 to-transparent"
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className={buttonClasses}
          >
            {url ? t("account.avatarChange") : t("account.avatarUpload")}
          </button>
          {url && (
            <button
              type="button"
              disabled={busy}
              onClick={onRemove}
              className={buttonClasses}
            >
              {t("account.avatarRemove")}
            </button>
          )}
        </div>
        <span className="text-[11.5px] text-black/35">
          {t("account.avatarHint")}
        </span>
        {error && <span className="text-[12px] text-red-600">{error}</span>}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onPick(f);
        }}
      />
    </div>
  );
}
