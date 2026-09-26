"use client";

import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";
import type { Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ContactProvider, hasContact } from "./PaidOffer";
import { sourceHost, sourceLabel, type RegistryEntry } from "./registry-types";

// 1.56.0 付費插件:沒開通時按鈕位置放什麼(registry 協定的 offer.action)。
//
//   access: requested       → 文字「已申請 · 9/23」,不是按鈕(日期是閘道回報的 requestedAt)
//   action: request         → 「申請使用」,開申請視窗;core 伺服器帶 token 轉送給這個 registry
//   action: link            → 「前往購買 ↗」,新分頁開 offer.url(noopener noreferrer,core 不附加參數)
//   其他(省略 action)       → 「聯絡提供者」(1.52.0 的樣子)
//
// 這個 registry 回 404(不收線上申請)之後,同一個來源的「申請使用」都換成「聯絡提供者」,
// 直到重新整理頁面。core 不存任何申請狀態:送出後商店重讀索引,閘道回 requested。

type Translator = ReturnType<typeof useT>;
export type PaidActionSize = "sm" | "md" | "lg";

/** 申請視窗與商店共用的東西(RegistryBrowser 提供)。 */
interface RequestContextValue {
  /** 「附上我的名字和 email」旁邊列出的,也是伺服器實際會送的(GET /api/registry/index 的 contact)。 */
  contact: { name: string; email: string } | null;
  /** 送出成功(或閘道說已經開通):商店就地改成已申請,再重讀索引。 */
  onRequested: (entry: RegistryEntry, outcome: "requested" | "granted") => void;
}

const RequestContext = createContext<RequestContextValue>({ contact: null, onRequested: () => {} });

export function RequestProvider({ value, children }: { value: RequestContextValue; children: ReactNode }) {
  return <RequestContext.Provider value={value}>{children}</RequestContext.Provider>;
}

// ── 不收線上申請的來源(這次開著頁面的期間)──────────────────────────────
let refusing: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const EMPTY: ReadonlySet<string> = new Set();

function markRefusing(source: string): void {
  refusing = new Set([...refusing, source]);
  for (const listener of listeners) listener();
}

function useRefusing(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => refusing,
    () => EMPTY,
  );
}

/** `2026-09-23` → 9/23(zh-Hant 與 en 都是這個樣子)。一律以 UTC 讀,伺服器與瀏覽器一致。 */
export function formatRequestDate(iso: string, locale: Locale): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "zh-Hant" ? "zh-TW" : "en-US", {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function RequestedNote({ entry, size }: { entry: RegistryEntry; size: PaidActionSize }) {
  const t = useT();
  const locale = useLocale();
  const date = entry.requestedAt ? formatRequestDate(entry.requestedAt, locale) : "";
  return (
    <span className={cn("tabular-nums text-ink/50", size === "lg" ? "text-[13px]" : "text-[12px]")}>
      {date ? t("registryBrowser.paid.requested", { date }) : t("registryBrowser.paid.requestedNoDate")}
    </span>
  );
}

const BUTTON_SIZE = {
  sm: "h-8 rounded-full px-3.5 text-[12px] bg-ink text-white hover:bg-ink/85",
  md: "h-9 rounded-full px-4 text-[13px] bg-ink text-white hover:bg-ink/85",
  lg: "h-10 w-full rounded-[calc(8px*var(--admin-radius-scale,1))] px-4 text-[13px] bg-ink text-white hover:bg-ink/85",
} as const;

const BUTTON_BASE =
  "inline-flex shrink-0 items-center justify-center gap-1 font-medium transition-[background-color,transform] duration-150 active:scale-[0.96]";

// 卡片本身 onClick 會開詳情頁;這些按鈕只做自己的事。
const stop = (e: MouseEvent) => e.stopPropagation();

function BuyLink({ entry, size }: { entry: RegistryEntry; size: PaidActionSize }) {
  const t = useT();
  return (
    <a
      href={entry.offer?.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      className={cn(BUTTON_BASE, BUTTON_SIZE[size])}
    >
      {t("registryBrowser.paid.buy")}
      <ArrowUpRight aria-hidden className="size-3.5" />
    </a>
  );
}

/** 沒開通的付費插件,按鈕位置的那一個(見檔頭)。 */
export function PaidAction({ entry, size }: { entry: RegistryEntry; size: PaidActionSize }) {
  const refusingSources = useRefusing();
  const [open, setOpen] = useState(false);
  const t = useT();
  if (entry.access === "requested") return <RequestedNote entry={entry} size={size} />;
  const action = entry.offer?.action;
  if (action === "link" && entry.offer?.url) return <BuyLink entry={entry} size={size} />;
  if (action !== "request" || refusingSources.has(entry.source)) return <ContactProvider entry={entry} size={size} />;
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn(BUTTON_BASE, BUTTON_SIZE[size])}
      >
        {t("registryBrowser.paid.request")}
      </button>
      {open && (
        <div onClick={stop}>
          <RequestDialog entry={entry} onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}

// ── 申請視窗 ─────────────────────────────────────────────────────────────

const NOTE_MAX = 500;

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "error"; message: string }
  | { kind: "notAccepted" };

function errorText(t: Translator, entry: RegistryEntry, code: string | undefined): string {
  if (code === "payload_too_large") return t("registryBrowser.request.tooLong");
  if (code === "rate_limited") return t("registryBrowser.request.rateLimited");
  if (code === "source_key_invalid") return t("registryBrowser.error.keyInvalid", { source: sourceLabel(entry.source) });
  return t("registryBrowser.request.failed");
}

async function postRequest(
  entry: RegistryEntry,
  note: string,
  contact: boolean,
): Promise<{ status: number; code?: string }> {
  try {
    const res = await fetch("/api/registry/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: entry.source,
        extension: entry.id,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(contact ? { contact: true } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return { status: res.status, code: typeof body.error === "string" ? body.error : undefined };
  } catch {
    return { status: 0 };
  }
}

/**
 * 一步完成:列出會送出去的東西(插件、留言、勾了才有的名字與 email),取消 / 送出。
 * 聯絡資料預設不勾。
 */
export function RequestDialog({ entry, onClose }: { entry: RegistryEntry; onClose: () => void }) {
  const t = useT();
  const { contact, onRequested } = useContext(RequestContext);
  const [note, setNote] = useState("");
  const [withContact, setWithContact] = useState(false);
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const host = sourceHost(entry.source);

  async function send() {
    setState({ kind: "sending" });
    const { status, code } = await postRequest(entry, note, withContact && contact !== null);
    if (status === 202) {
      onRequested(entry, "requested");
      onClose();
      return;
    }
    if (status === 409 && code === "already_granted") {
      onRequested(entry, "granted");
      onClose();
      return;
    }
    if (status === 404 && code === "requests_not_accepted") {
      markRefusing(entry.source);
      setState({ kind: "notAccepted" });
      return;
    }
    setState({ kind: "error", message: errorText(t, entry, code) });
  }

  const sending = state.kind === "sending";
  return (
    <Dialog open onOpenChange={(next) => !next && !sending && onClose()}>
      <DialogContent className="max-w-md rounded-[calc(20px*var(--admin-radius-scale,1))] p-0 shadow-[var(--admin-shadow-panel,0_16px_48px_-12px_rgba(30,20,50,0.18))]">
        <div className="flex flex-col gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{t("registryBrowser.request.title", { name: entry.name })}</DialogTitle>
            <DialogDescription>{t("registryBrowser.request.intro", { host })}</DialogDescription>
          </DialogHeader>

          {state.kind === "notAccepted" ? (
            <p className="text-[13px] leading-relaxed text-ink/70">{t("registryBrowser.request.notAccepted", { host })}</p>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-ink/55">{t("registryBrowser.request.note")}</span>
                <Textarea
                  value={note}
                  maxLength={NOTE_MAX}
                  rows={3}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={sending}
                />
              </label>
              {contact && (
                <label className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox
                    checked={withContact}
                    onCheckedChange={(checked) => setWithContact(checked === true)}
                    disabled={sending}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13px] text-ink/80">{t("registryBrowser.request.contact")}</span>
                    <span className="truncate text-[12px] text-ink/45">
                      {contact.name} · {contact.email}
                    </span>
                  </span>
                </label>
              )}
              {state.kind === "error" && (
                <p role="alert" className="text-[12.5px] text-red-700">
                  {state.message}
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            {state.kind === "notAccepted" ? (
              <>
                <Button variant="outline" onClick={onClose}>
                  {t("registryBrowser.request.close")}
                </Button>
                {hasContact(entry) && <ContactProvider entry={entry} size="md" />}
              </>
            ) : (
              <>
                <Button variant="outline" onClick={onClose} disabled={sending}>
                  {t("registryBrowser.request.cancel")}
                </Button>
                <Button onClick={() => void send()} disabled={sending}>
                  {sending ? t("registryBrowser.request.sending") : t("registryBrowser.request.send")}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
