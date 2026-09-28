"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, Copy } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useDateFormatter } from "@/components/DateTimeProvider";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";
import { relativeTimeWords } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { McpConnection } from "@/lib/mcp/grants";

// 設定頁的「AI 連線」卡(1.59.0)。讀的人是店主,不是開發者:畫面上只有開關、一個要複製的
// 網址、一句貼到哪裡,以及已連線的 App。沒有 scope、token、JSON 設定檔 —— 那些都在 App 與
// 網站之間自己處理(src/lib/mcp/)。
//
// 開關寫的是 core.mcp.enabled,走既有的 PUT /api/settings(同一套驗證與快取失效),存完
// router.refresh() 讓伺服器重畫。中斷連線走 DELETE /api/ai-connections/[id],原地二段確認
// (同 PasskeyRow / IdentitiesManager 的作法:一句後果 + 取消 / 中斷)。
//
// 這張卡畫在設定頁的 <form> 裡:所有按鈕都是 type="button",不能再包一層 form。

interface AiConnectCardProps {
  enabled: boolean;
  mcpUrl: string;
  connections: McpConnection[];
  /** server 算好的時間,SSR/CSR 的相對時間才一致(同 /admin/agent/audit)。 */
  now: number;
}

const ENABLED_KEY = "core.mcp.enabled";

const BUTTON_QUIET =
  "h-8 cursor-pointer rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 text-[12.5px] font-medium text-ink/55 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.08))] transition-[color,box-shadow,transform] duration-150 hover:text-ink/85 hover:shadow-[0_0_0_1px_rgba(0,0,0,0.18)] active:scale-[0.96] disabled:opacity-50";

export function AiConnectCard({ enabled: initialEnabled, mcpUrl, connections: initial, now }: AiConnectCardProps) {
  const t = useT();
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [connections, setConnections] = useState(initial);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setError(null);
    setSaving(true);
    setEnabled(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: { [ENABLED_KEY]: next } }),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      setEnabled(!next);
      setError(t("aiConnect.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    setConfirmingId(null);
    setError(null);
    const before = connections;
    setConnections((list) => list.filter((c) => c.id !== id));
    try {
      const res = await fetch(`/api/ai-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      setConnections(before);
      setError(t("aiConnect.revokeFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-ink/90">{t("aiConnect.title")}</h3>
        <p className="text-[12px] leading-relaxed text-ink/40">{t("aiConnect.desc")}</p>
      </div>

      <label className="flex cursor-pointer items-start justify-between gap-4 rounded-[calc(10px*var(--admin-radius-scale,1))] bg-ink/[0.03] px-4 py-3 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium text-ink/80">{t("aiConnect.switch")}</span>
          <span className="text-[12px] leading-relaxed text-ink/40">{t("aiConnect.switchNote")}</span>
        </span>
        <Switch checked={enabled} disabled={saving} onCheckedChange={(next) => void toggle(next)} className="mt-0.5" />
      </label>

      {enabled && <ConnectUrl url={mcpUrl} />}

      {error && (
        <p role="alert" className="flex items-center gap-2 text-[12.5px] text-red-700">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        <h4 className="text-[13px] font-medium text-ink/55">{t("aiConnect.connected")}</h4>
        {connections.length === 0 ? (
          <p className="text-[13px] text-ink/40">{t("aiConnect.none")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {connections.map((c) => (
              <ConnectionRow
                key={c.id}
                connection={c}
                now={now}
                confirming={confirmingId === c.id}
                onRequest={() => setConfirmingId(c.id)}
                onCancel={() => setConfirmingId(null)}
                onConfirm={() => void revoke(c.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ConnectUrl({ url }: { url: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪貼簿不可用:網址本身可以選取複製。
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink/55">{t("aiConnect.url")}</span>
      <div className="flex items-center gap-2 rounded-[calc(10px*var(--admin-radius-scale,1))] bg-surface px-3 py-2 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]">
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink/85 select-all">{url}</code>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[calc(6px*var(--admin-radius-scale,1))] px-2.5 text-[12.5px] font-medium text-ink/60 transition-[background-color,color,transform] duration-150 hover:bg-ink/[0.06] hover:text-ink/85 active:scale-[0.96]"
        >
          {copied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
          {copied ? t("aiConnect.copied") : t("aiConnect.copy")}
        </button>
      </div>
      <p className="text-[12px] leading-relaxed text-ink/40">{t("aiConnect.where")}</p>
    </div>
  );
}

interface ConnectionRowProps {
  connection: McpConnection;
  now: number;
  confirming: boolean;
  onRequest: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConnectionRow({ connection: c, now, confirming, onRequest, onCancel, onConfirm }: ConnectionRowProps) {
  const t = useT();
  const locale = useLocale();
  const dates = useDateFormatter();
  const app = c.app || t("aiConnect.unnamed");

  // 一列一個 App:名字 + 中斷鈕,下面是固定寬度標籤欄的鍵值清單(管理頁的慣例)。
  const details: { label: string; value: string; numeric?: boolean }[] = [
    { label: t("aiConnect.access"), value: c.scope === "write" ? t("aiConnect.accessWrite") : t("aiConnect.accessRead") },
    { label: t("aiConnect.approvedBy"), value: c.approvedBy },
    { label: t("aiConnect.connectedAt"), value: dates.format(c.connectedAt, { dateStyle: "medium" }), numeric: true },
    {
      label: t("aiConnect.lastUsed"),
      value:
        c.lastUsedAt === null ? t("aiConnect.neverUsed") : relativeTimeWords(c.lastUsedAt, now, locale, dates.timeZone),
      numeric: true,
    },
  ];

  return (
    <li className="flex flex-col gap-2.5 rounded-[calc(10px*var(--admin-radius-scale,1))] bg-surface px-4 py-3 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[14px] font-medium text-ink/85">{app}</span>
        {!confirming && (
          <button
            type="button"
            onClick={onRequest}
            aria-label={t("aiConnect.revokeNamed", { app })}
            className={BUTTON_QUIET}
          >
            {t("aiConnect.revoke")}
          </button>
        )}
      </div>

      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
        {details.map(({ label, value, numeric }) => (
          <div key={label} className="contents">
            <dt className="text-ink/40">{label}</dt>
            <dd className={cn("min-w-0 truncate text-ink/75", numeric && "tabular-nums")}>{value}</dd>
          </div>
        ))}
      </dl>

      {confirming && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink/[0.06] pt-2.5">
          <span className="text-[12.5px] text-ink/60">{t("aiConnect.revokeConfirm", { app })}</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 cursor-pointer rounded-[calc(8px*var(--admin-radius-scale,1))] px-2.5 text-[12.5px] text-ink/50 transition-colors hover:text-ink/80"
            >
              {t("aiConnect.cancel")}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="h-8 cursor-pointer rounded-[calc(8px*var(--admin-radius-scale,1))] bg-red-600 px-3 text-[12.5px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-red-700 active:scale-[0.96]"
            >
              {t("aiConnect.revoke")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
