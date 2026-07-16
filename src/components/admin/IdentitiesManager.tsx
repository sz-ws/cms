"use client";

import { useState } from "react";
import { AlertCircle, Check, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { StackedList } from "@/components/ui/stacked-list";
import { useT } from "@/lib/i18n/I18nProvider";

// 帳號頁「已連結帳號」區(spec-login-providers §6/§7)。資料由 server
// (admin/account/page.tsx)備好:identities 直接查 user_identities,providers 走
// listLoginProviders();connectedAtLabel 在 server 端按 locale 格式化,client 不碰
// Date(避免 SSR/CSR 時區與 locale 不一致)。

export interface IdentitySummary {
  id: string;
  provider: string;
  display: string | null;
  /** server 端已按 locale 格式化的連結日期字串。 */
  connectedAtLabel: string;
}

export interface IdentityProviderOption {
  id: string;
  label: string;
  svg?: string;
  background?: string;
  foreground?: string;
}

interface IdentitiesManagerProps {
  initialIdentities: IdentitySummary[];
  providers: IdentityProviderOption[];
  /** OAuth link 回跳的 ?linked=1(成功 banner)。 */
  linked?: boolean;
  /** OAuth link 回跳的 ?error=<code>。 */
  errorCode?: string;
}

function urlErrorKey(code: string) {
  switch (code) {
    case "identity_taken":
      return "account.error.identityTaken" as const;
    default:
      return "account.error.identityGeneric" as const;
  }
}

function ProviderMark({ provider }: { provider?: IdentityProviderOption }) {
  if (provider?.svg) {
    return (
      <span
        aria-hidden
        className="inline-flex size-8 items-center justify-center rounded-[8px] shadow-[0_0_0_1px_rgba(0,0,0,0.08)] [&>svg]:size-[16px]"
        style={{ background: provider.background ?? "#ffffff" }}
        // 安裝時已過 svg-guard(allowlist 驗證),渲染端視為可信。
        dangerouslySetInnerHTML={{ __html: provider.svg }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex size-8 items-center justify-center rounded-[8px] bg-black/[0.04] shadow-[0_0_0_1px_rgba(0,0,0,0.06)]"
    >
      <Link2 className="size-4 text-black/35" />
    </span>
  );
}

export function IdentitiesManager({
  initialIdentities,
  providers,
  linked,
  errorCode,
}: IdentitiesManagerProps) {
  const t = useT();
  const [identities, setIdentities] = useState(initialIdentities);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // URL 帶回的 flash 只當初始值;之後的錯誤/成功由本地互動接手。
  const [error, setError] = useState<string | null>(() =>
    errorCode ? t(urlErrorKey(errorCode)) : null,
  );
  const [notice, setNotice] = useState<string | null>(() =>
    linked ? t("account.identityLinked") : null,
  );

  const connectedProviderIds = new Set(identities.map((i) => i.provider));
  const connectable = providers.filter((p) => !connectedProviderIds.has(p.id));

  async function onDisconnect(id: string) {
    setConfirmingId(null);
    setError(null);
    setNotice(null);
    const prev = identities;
    setIdentities((list) => list.filter((i) => i.id !== id));
    try {
      const res = await fetch(`/api/account/identities/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setIdentities(prev); // rollback
        setError(
          body?.error === "last_login_method"
            ? t("account.error.identityLastMethod")
            : t("account.error.identityGeneric"),
        );
        return;
      }
      setNotice(t("account.identityDisconnected"));
    } catch {
      setIdentities(prev); // rollback
      setError(t("account.error.identityGeneric"));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700"
        >
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-[8px] border border-emerald-600/15 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-700"
        >
          <Check className="size-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {identities.length === 0 ? (
        <p className="text-[13px] text-black/40">
          {t("account.identityNoneConnected")}
        </p>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-black/10 bg-white">
          <StackedList>
            {identities.map((identity) => {
              const provider = providers.find((p) => p.id === identity.provider);
              const confirming = confirmingId === identity.id;
              return (
                <li
                  key={identity.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <ProviderMark provider={provider} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] font-medium text-black/85">
                      {provider?.label ?? identity.provider}
                    </span>
                    <span className="truncate text-[12px] text-black/40">
                      {identity.display ? `${identity.display} · ` : ""}
                      {t("account.identityConnectedAt", {
                        date: identity.connectedAtLabel,
                      })}
                    </span>
                  </div>
                  {confirming ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void onDisconnect(identity.id)}
                        className="h-8 cursor-pointer rounded-[8px] bg-red-600 px-3 text-[12.5px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-red-700 active:scale-[0.96]"
                      >
                        {t("account.identityDisconnect")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        className="h-8 cursor-pointer rounded-[8px] px-2.5 text-[12.5px] text-black/50 transition-colors hover:text-black/80"
                      >
                        {t("userSheet.cancel")}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingId(identity.id)}
                      className="h-8 cursor-pointer rounded-[8px] px-3 text-[12.5px] font-medium text-black/50 shadow-[0_0_0_1px_rgba(0,0,0,0.08)] transition-[color,box-shadow,transform] duration-150 hover:text-black/80 hover:shadow-[0_0_0_1px_rgba(0,0,0,0.18)] active:scale-[0.96]"
                    >
                      {t("account.identityDisconnect")}
                    </button>
                  )}
                </li>
              );
            })}
          </StackedList>
        </div>
      )}

      {connectable.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {connectable.map((p) => (
            <a
              key={p.id}
              href={`/api/auth/oauth/${encodeURIComponent(p.id)}/start?mode=link&next=/admin/account`}
              className={cn(
                "flex h-9 items-center gap-2 rounded-[8px] px-3 text-[13px] font-medium",
                "shadow-[0_0_0_1px_rgba(0,0,0,0.08)] transition-[filter,transform] duration-150 ease-out",
                "hover:brightness-[0.97] active:scale-[0.96]",
              )}
              style={{
                background: p.background ?? "#ffffff",
                color: p.foreground ?? "rgba(0,0,0,0.85)",
              }}
            >
              {p.svg && (
                <span
                  aria-hidden
                  className="inline-flex [&>svg]:size-[15px]"
                  dangerouslySetInnerHTML={{ __html: p.svg }}
                />
              )}
              <span>
                {t("account.identityConnect")} · {p.label}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
