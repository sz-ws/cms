"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Trash2,
  Check,
  Copy,
  KeyRound,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useImeGuard } from "@/lib/ime";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useT, useLocale } from "@/lib/i18n/I18nProvider";

// roadmap #1 §5:API Tokens manager(mirror RegistrySourcesManager 模式)。
// 列出 tokens(server 只下發 prefix / scope / 時間,永不含 raw 或 hash);「New token」
// dialog 建立後 raw 只此一次顯示 —— 明顯區塊 + 複製鈕 + 「離開後無法再看到」警語。

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  lastUsedAt: number | null;
  createdAt: number;
}

interface ApiTokensManagerProps {
  initialTokens: ApiToken[];
}

// SSR/CSR 都以 admin 的 core.locale 為準(undefined 會吃瀏覽器 locale,
// server render 對不上會 hydration mismatch)。
function formatDate(ms: number | null, locale: "en" | "zh-Hant"): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleDateString(
      locale === "zh-Hant" ? "zh-TW" : "en-US",
      {
        year: "numeric",
        month: "short",
        day: "numeric",
      },
    );
  } catch {
    return "—";
  }
}

export function ApiTokensManager({ initialTokens }: ApiTokensManagerProps) {
  const t = useT();
  const ime = useImeGuard();
  const locale = useLocale();
  const router = useRouter();
  const [tokens, setTokens] = useState<ApiToken[]>(initialTokens);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 建立成功後一次性顯示的 raw token(關閉 dialog 即清空,永不再顯示)。
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function openDialog() {
    setNewName("");
    setError(null);
    setRawToken(null);
    setCopied(false);
    setDialogOpen(true);
  }

  function closeDialog(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setRawToken(null);
      setNewName("");
      setError(null);
      setCopied(false);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403 ? t("apiTokens.notAllowed") : t("apiTokens.createFailed"));
        return;
      }
      const data = (await res.json()) as { id: string; prefix: string; raw: string };
      setRawToken(data.raw);
      router.refresh();
    } catch {
      setError(t("apiTokens.networkError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!rawToken) return;
    try {
      await navigator.clipboard.writeText(rawToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard 不可用時忽略(使用者仍可手動選取複製)。
    }
  }

  async function handleRevoke(id: string) {
    setTokens((prev) => prev.filter((t) => t.id !== id));
    try {
      await fetch(`/api/tokens/${id}`, { method: "DELETE" });
      router.refresh();
    } catch {
      // 撤銷失敗:refresh 會還原 server 真實狀態。
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-4 pt-6 border-t border-black/[0.06]">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
            {t("apiTokens.title")}
          </h3>
          <p className="text-[12px] text-black/40">
            {t("apiTokens.desc")}
          </p>
        </div>
        <Button onClick={openDialog} className="gap-1.5" size="sm">
          <Plus className="size-4" />
          {t("apiTokens.newToken")}
        </Button>
      </div>

      {tokens.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-black/20 p-8 text-center">
          <p className="text-[13px] text-black/45">{t("apiTokens.noTokensYet")}</p>
          <p className="mt-1 text-[12px] text-black/35">
            {t("apiTokens.noTokensDesc")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tokens.map((token) => (
            <div
              key={token.id}
              className="group flex items-center justify-between rounded-[10px] border border-black/10 bg-white px-4 py-3 transition-colors hover:border-black/20"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-black/[0.04] text-black/45">
                  <KeyRound className="size-4" />
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[14px] font-medium text-black/85">
                    {token.name}
                  </span>
                  <span className="flex items-center gap-2 text-[11px] text-black/40">
                    <code className="font-mono">{token.prefix}…</code>
                    <span className="uppercase tracking-wide">{token.scope}</span>
                    <span>{t("apiTokens.used", { date: formatDate(token.lastUsedAt, locale) })}</span>
                    <span>{t("apiTokens.created", { date: formatDate(token.createdAt, locale) })}</span>
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => handleRevoke(token.id)}
                  className="rounded-[6px] p-1.5 text-black/35 hover:bg-red-50 hover:text-red-600"
                  title={t("apiTokens.revokeToken")}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={closeDialog}>
        <DialogContent className="max-w-md rounded-[20px] p-0 shadow-[0_16px_48px_-12px_rgba(30,20,50,0.18)]">
          <div className="flex flex-col gap-4 p-5">
            <DialogHeader>
              <DialogTitle>
                {rawToken ? t("apiTokens.tokenCreated") : t("apiTokens.newApiToken")}
              </DialogTitle>
              <DialogDescription>
                {rawToken
                  ? t("apiTokens.copyNowWarning")
                  : t("apiTokens.nameLater")}
              </DialogDescription>
            </DialogHeader>

            {rawToken ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-2 rounded-[8px] bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{t("apiTokens.onlyTimeShown")}</span>
                </div>
                <div className="flex items-center gap-2 rounded-[10px] border border-black/10 bg-black/[0.03] px-3 py-2.5">
                  <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-black/85">
                    {rawToken}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="shrink-0 rounded-[6px] p-1.5 text-black/45 hover:bg-black/[0.06] hover:text-black/85"
                    title={t("apiTokens.copy")}
                  >
                    {copied ? (
                      <Check className="size-4 text-green-600" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </button>
                </div>
                <Button onClick={() => closeDialog(false)} className="mt-1">
                  {t("apiTokens.done")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-black/55">
                    {t("apiTokens.tokenName")}
                  </label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t("apiTokens.tokenNamePlaceholder")}
                    autoFocus
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    onKeyDown={(e) => {
                      // 組字中的 Enter 是在確定候選字(見 @/lib/ime)。
                      if (ime.isComposingKey(e)) return;
                      if (e.key === "Enter") handleCreate();
                    }}
                  />
                </div>
                {error && (
                  <p className="text-[12px] text-red-600">{error}</p>
                )}
                <Button
                  onClick={handleCreate}
                  disabled={!newName.trim() || creating}
                  className="mt-1 gap-1.5"
                >
                  {creating && <Loader2 className="size-4 animate-spin" />}
                  {creating ? t("apiTokens.creating") : t("apiTokens.createToken")}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
