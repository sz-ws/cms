"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import NumberFlow from "@number-flow/react";
import { TextMorph } from "torph/react";
import { Power, Trash2 } from "lucide-react";
import { CoreTable, RowIconButton, type CoreColumn } from "@/components/admin/core-table";
import { RegistryBrowser } from "./RegistryBrowser";
import { ExtensionSheet } from "./ExtensionSheet";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";

export interface ExtensionRow {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  installed: boolean;
  kind: "code" | "declarative";
}

interface ExtensionsManagerProps {
  extensions: ExtensionRow[];
}

export type Action = "enable" | "disable" | "uninstall";
type Tab = "installed" | "browse";

// 琺瑯 pill(頂光 + 內高光 + 同色 hairline,配方同 users 的 RolePill):
// enabled 走綠、disabled 走中性。TextMorph 讓 enable/disable 切換時字自己變形。
export function StatusPill({ enabled }: { enabled: boolean }) {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.04em] uppercase",
        enabled ? "text-[rgb(18,124,88)]" : "text-black/50",
      )}
      style={{
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0) 58%)",
        backgroundColor: enabled ? "rgba(16,145,90,0.12)" : "rgba(0,0,0,0.05)",
        boxShadow: enabled
          ? "inset 0 1px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(16,145,90,0.18), 0 1px 1.5px rgba(20,90,60,0.08)"
          : "inset 0 1px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(0,0,0,0.06), 0 1px 1.5px rgba(0,0,0,0.04)",
      }}
    >
      <TextMorph respectReducedMotion>
        {enabled ? t("extensions.enabled") : t("extensions.disabled")}
      </TextMorph>
    </span>
  );
}

export function KindBadge({ kind }: { kind: ExtensionRow["kind"] }) {
  const t = useT();
  if (kind !== "declarative") return null;
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium text-[rgb(76,102,210)]"
      style={{
        backgroundColor: "rgba(86,114,228,0.10)",
        boxShadow: "inset 0 0 0 1px rgba(86,114,228,0.16)",
      }}
    >
      {t("extensions.declarative")}
    </span>
  );
}

function InstalledTab({ extensions }: { extensions: ExtensionRow[] }) {
  const t = useT();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // sheet 以 id 尋址,資料永遠取自最新的 extensions prop(router.refresh() 後
  // enable 狀態就地更新;uninstall 後找不到該列 → request 變 null → sheet 退場)。
  // seq 每次「打開」遞增,當 sheet body 的 key —— 確認面板等內部狀態全新。
  const [open, setOpen] = useState<{
    id: string;
    confirm: boolean;
    seq: number;
  } | null>(null);

  function openSheet(id: string, confirm: boolean) {
    setOpen((prev) => ({ id, confirm, seq: (prev?.seq ?? 0) + 1 }));
  }

  const openExt = open
    ? (extensions.find((e) => e.id === open.id) ?? null)
    : null;

  async function run(
    extId: string,
    action: Action,
    kind: ExtensionRow["kind"],
    purgeContent?: boolean,
  ) {
    setError(null);
    setPending(`${extId}:${action}`);
    try {
      const res = await fetch(`/api/extensions/${extId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, kind, purgeContent }),
      });
      if (res.ok) {
        router.refresh();
      } else if (res.status === 403) {
        setError(t("extensions.notAllowed"));
      } else if (res.status === 500 && action === "enable") {
        setError(t("extensions.enableIncomplete"));
      } else {
        setError(t("extensions.actionFailed"));
      }
    } catch {
      setError(t("extensions.networkError"));
    } finally {
      setPending(null);
    }
  }

  const columns: CoreColumn<ExtensionRow>[] = [
    {
      key: "name",
      label: t("extensions.name"),
      sortable: true,
      sortValue: (e) => e.name.toLowerCase(),
      tdClass: "py-3 pr-4",
      render: (e) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-black/85">
            <span className="truncate">{e.name}</span>
            <KindBadge kind={e.kind} />
          </span>
          {e.description && (
            <span className="max-w-[36ch] truncate text-[12px] text-black/40">
              {e.description}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "version",
      label: t("extensions.version"),
      sortable: true,
      sortValue: (e) => e.version,
      render: (e) => (
        <span className="text-[12.5px] whitespace-nowrap text-black/45 tabular-nums">
          {e.version}
        </span>
      ),
    },
    {
      key: "status",
      label: t("extensions.status"),
      sortable: true,
      sortValue: (e) => (e.enabled ? 0 : 1),
      render: (e) => <StatusPill enabled={e.enabled} />,
    },
  ];

  if (extensions.length === 0) {
    return (
      <div className="rounded-[14px] border border-dashed border-black/20 p-8 text-center">
        <p className="text-[13px] text-black/45">
          {t("extensions.noExtensions")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p
          role="alert"
          className="rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700"
        >
          {error}
        </p>
      )}

      <CoreTable
        columns={columns}
        rows={extensions}
        rowKey={(e) => e.id}
        onRowClick={(e) => openSheet(e.id, false)}
        rowActive={(e) => open?.id === e.id && openExt !== null}
        trailingLabel={t("extensions.actions")}
        trailingActions={(e) => (
          <>
            <RowIconButton
              label={e.enabled ? t("extensions.disable") : t("extensions.enable")}
              onClick={() =>
                pending === null &&
                void run(e.id, e.enabled ? "disable" : "enable", e.kind)
              }
            >
              {pending === `${e.id}:enable` || pending === `${e.id}:disable` ? (
                <span className="text-[12px]">…</span>
              ) : (
                <Power className="size-3.5" />
              )}
            </RowIconButton>
            {e.installed && (
              <RowIconButton
                label={t("extensions.uninstall")}
                danger
                onClick={() => openSheet(e.id, true)}
              >
                <Trash2 className="size-3.5" />
              </RowIconButton>
            )}
          </>
        )}
      />

      {/* 常駐 mount:open 切換才有進退場動畫(見 ExtensionSheet 註解)。 */}
      <ExtensionSheet
        request={
          open && openExt
            ? { ext: openExt, confirm: open.confirm, seq: open.seq }
            : null
        }
        pending={pending}
        onClose={() => setOpen(null)}
        onAction={(id, action, kind, purgeContent) =>
          void run(id, action, kind, purgeContent)
        }
      />
    </div>
  );
}

export function ExtensionsManager({ extensions }: ExtensionsManagerProps) {
  const t = useT();
  // The Shop sidebar group deep-links here: "Browse store" → ?tab=browse,
  // "Installed" → no tab. Seed local tab state from the URL param.
  const searchParams = useSearchParams();
  const initialTab: Tab =
    searchParams.get("tab") === "browse" ? "browse" : "installed";
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 border-b">
        <button
          type="button"
          onClick={() => setTab("installed")}
          className={cn(
            "px-3 py-2 text-sm font-medium transition-colors",
            tab === "installed"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("extensions.installed")} <NumberFlow value={extensions.length} />
        </button>
        <button
          type="button"
          onClick={() => setTab("browse")}
          className={cn(
            "px-3 py-2 text-sm font-medium transition-colors",
            tab === "browse"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("extensions.browse")}
        </button>
      </div>
      {tab === "installed" ? (
        <InstalledTab extensions={extensions} />
      ) : (
        <RegistryBrowser />
      )}
    </div>
  );
}
