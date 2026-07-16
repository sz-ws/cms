"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertCircle, Plus } from "lucide-react";
import {
  startRegistration,
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import {
  StatusButton,
  type StatusButtonStatus,
} from "@/components/ui/status-button";
import { StackedList } from "@/components/ui/stacked-list";
import { FaceIdIcon } from "@/components/ui/face-id-icon";
import { useT } from "@/lib/i18n/I18nProvider";
import { PasskeyRow } from "@/components/admin/PasskeyRow";
import { PasskeyNameDialog } from "@/components/admin/PasskeyNameDialog";

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface PasskeysManagerProps {
  initialPasskeys: PasskeySummary[];
  /** server 算好的請求時間,讓列表的相對時間字串 SSR/CSR 一致(見 lib/relative-time.ts)。 */
  now: number;
}

// useSyncExternalStore 的空訂閱:能力偵測是常數,不會變、不需要通知。
function subscribeNoop(): () => void {
  return () => {};
}

const RESET_DELAY_MS = 1500;

function statusLabel(
  status: StatusButtonStatus,
  t: ReturnType<typeof useT>,
): string {
  if (status === "loading") return t("passkeys.adding");
  if (status === "success") return t("passkeys.added");
  if (status === "error") return t("passkeys.failed");
  return t("passkeys.addPasskey");
}

export function PasskeysManager({ initialPasskeys, now }: PasskeysManagerProps) {
  const t = useT();
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>(initialPasskeys);
  // client-only 能力偵測:server snapshot 給 null(SSR/hydration 一致)。
  const supported = useSyncExternalStore(
    subscribeNoop,
    browserSupportsWebAuthn,
    () => null,
  );
  const [status, setStatus] = useState<StatusButtonStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  // 每次新一輪 ceremony 都 +1,當 PasskeyNameDialog 的 key 用來強制 remount ——
  // 讓命名輸入框自然歸零,不必用 effect+setState(見該檔案註解)。
  const [namingSession, setNamingSession] = useState(0);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // ceremony 已完成、等命名 dialog 決定名稱後才送 verify 的 attestation。ref 而非
  // state:純粹是「暫存到下一步」,變動不需要觸發重繪。
  const pendingAttestation = useRef<RegistrationResponseJSON | null>(null);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    };
  }, []);

  function scheduleReset() {
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setStatus("idle"), RESET_DELAY_MS);
  }

  // L1 §5:新增 passkey 第一步 —— register options → startRegistration。WebAuthn
  // ceremony 先跑(趁 user activation 還新鮮),成功後開命名 dialog;真正的 verify
  // 留到 dialog 送出後才打(見 finishAdd),這裡只負責拿到 attestation。
  async function onAdd() {
    setError(null);
    setStatus("loading");
    try {
      const optRes = await fetch("/api/auth/passkey/register/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!optRes.ok) throw new Error("options_failed");
      const optionsJSON =
        (await optRes.json()) as PublicKeyCredentialCreationOptionsJSON;

      pendingAttestation.current = await startRegistration({ optionsJSON });
      setNamingSession((n) => n + 1);
      setNameDialogOpen(true);
    } catch {
      setStatus("error");
      setError(t("passkeys.addError"));
      scheduleReset();
    }
  }

  // 命名 dialog 送出(不論輸入了名字還是用預設)→ verify,把 credential 真正存進 D1。
  async function finishAdd(name: string | undefined) {
    setNameDialogOpen(false);
    const attestation = pendingAttestation.current;
    pendingAttestation.current = null;
    if (!attestation) return;
    try {
      const verifyRes = await fetch("/api/auth/passkey/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...attestation, name }),
      });
      if (!verifyRes.ok) throw new Error("verify_failed");
      const created = (await verifyRes.json()) as { id: string; name: string };
      setPasskeys((prev) => [
        ...prev,
        {
          id: created.id,
          name: created.name,
          createdAt: Date.now(),
          lastUsedAt: null,
        },
      ]);
      setStatus("success");
    } catch {
      setStatus("error");
      setError(t("passkeys.addErrorGeneric"));
    } finally {
      scheduleReset();
    }
  }

  async function onDelete(id: string) {
    setConfirmingId(null);
    setError(null);
    const prev = passkeys;
    setPasskeys((p) => p.filter((k) => k.id !== id));
    try {
      const res = await fetch(`/api/auth/passkey/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("delete_failed");
    } catch {
      setPasskeys(prev); // rollback
      setError(t("passkeys.removeError"));
    }
  }

  const label = statusLabel(status, t);
  // 冷眼回報 2026-07-16:「新增 Passkey」文字曾在 zh 下逐字直排。StatusButton 把
  // label 拆成單字元 motion.span 做 morph 動畫(src/components/ui/status-button.tsx,
  // 共用元件、不在本次改動範圍內),中文沒有天然斷字點,一旦外層被擠到比內容窄就會
  // 逐字換行。這裡從外層包一層不可壓縮寬度(w-max + shrink-0)當保險,擋掉任何來自
  // 上層 flex/grid 的擠壓;特意不用 [&_span]:whitespace-nowrap 之類的萬用選擇器 ——
  // 那會連字元間那個「純空格」motion.span 原本刻意設的 whitespace-pre 一起蓋掉,
  // 讓空格塌陷成 0 寬(實測會變成「新增Passkey」黏在一起,是另一個迴歸)。
  const addButton = (
    <span className="inline-flex w-max shrink-0">
      <StatusButton
        size="sm"
        status={status}
        label={label}
        idleIcon={<Plus className="size-3" />}
        onClick={() => void onAdd()}
      />
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      {supported && passkeys.length > 0 && (
        <div className="flex justify-end">{addButton}</div>
      )}

      {supported === false && (
        <div className="flex items-center gap-2 rounded-[8px] bg-black/[0.03] px-3 py-2 text-[13px] text-black/50">
          <AlertCircle className="size-4 shrink-0" />
          <span>{t("passkeys.browserUnsupported")}</span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700"
        >
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {passkeys.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-black/15 px-8 py-10 text-center">
          <FaceIdIcon className="size-9 text-black/20" />
          <div className="flex flex-col gap-1">
            <p className="text-[13px] text-black/45">{t("passkeys.noPasskeysYet")}</p>
            <p className="text-[12px] text-black/35">
              {t("passkeys.noPasskeysDesc")}
            </p>
          </div>
          {supported && <div className="mt-1">{addButton}</div>}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-black/10 bg-white">
          <StackedList>
            {passkeys.map((k) => (
              <PasskeyRow
                key={k.id}
                passkey={k}
                now={now}
                confirming={confirmingId === k.id}
                onRequestDelete={() => setConfirmingId(k.id)}
                onCancelDelete={() => setConfirmingId(null)}
                onConfirmDelete={() => void onDelete(k.id)}
              />
            ))}
          </StackedList>
        </div>
      )}

      <PasskeyNameDialog
        key={namingSession}
        open={nameDialogOpen}
        onSubmit={(name) => void finishAdd(name)}
      />
    </div>
  );
}
