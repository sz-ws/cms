"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusButton } from "@/components/ui/status-button";
import { FaceIdIcon } from "@/components/ui/face-id-icon";
import { cn } from "@/lib/utils";
import { RolePill, type UserRecord } from "./UsersTable";
import { useT } from "@/lib/i18n/I18nProvider";

export type SheetMode =
  | { mode: "create" }
  | { mode: "edit"; user: UserRecord };

type Role = "admin" | "editor" | "guest";

function FieldShell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-black/55">{label}</span>
      {children}
    </label>
  );
}

const INPUT_CLS =
  "h-9 w-full rounded-[8px] border border-black/10 bg-white px-3 text-[13.5px] text-black/85 transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-black/25 focus:border-black/30 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.05)]";

// /admin/users 的編輯/新增 sidebar(core-native「設定從側邊滑出」的體例)。
// 殼常駐、open 由 mode 是否為 null 驅動 —— 條件式 mount + open=true 會讓 base-ui
// 跳過 starting-style,面板瞬間出現;常駐切 open 才有進退場動畫。
// held 保留最後一個非 null mode,退場動畫期間內容不消失;session key 讓每次
// 重新打開時表單 state 全新(避免 effect+setState 重置)。
export function UserSheet({
  mode,
  selfId,
  onClose,
  onSaved,
  onDeleted,
}: {
  mode: SheetMode | null;
  selfId: string;
  onClose: () => void;
  onSaved: (u: UserRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const [held, setHeld] = useState<SheetMode | null>(mode);
  const [session, setSession] = useState(0);
  if (mode && mode !== held) {
    // render-time adjust(官方 adjust-state-when-props-change 模式)
    setHeld(mode);
    setSession((n) => n + 1);
  }

  return (
    <Sheet open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton
        className="duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-[side=right]:sm:max-w-[25rem]"
      >
        {held && (
          <UserSheetForm
            key={session}
            mode={held}
            selfId={selfId}
            onClose={onClose}
            onSaved={onSaved}
            onDeleted={onDeleted}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// create:email+name+role+password 全填;edit:email 唯讀(身分),name/role 就地改,
// password 收在「Reset password」下,danger zone 只在編他人時出現。
function UserSheetForm({
  mode,
  selfId,
  onClose,
  onSaved,
  onDeleted,
}: {
  mode: SheetMode;
  selfId: string;
  onClose: () => void;
  onSaved: (u: UserRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useT();
  const editing = mode.mode === "edit" ? mode.user : null;
  const isSelf = editing?.id === selfId;

  const roleOptions: { value: Role; title: string; hint: string }[] = [
    {
      value: "admin",
      title: t("userSheet.roleAdmin"),
      hint: t("userSheet.roleAdminHint"),
    },
    {
      value: "editor",
      title: t("userSheet.roleEditor"),
      hint: t("userSheet.roleEditorHint"),
    },
    {
      value: "guest",
      title: t("userSheet.roleGuest"),
      hint: t("userSheet.roleGuestHint"),
    },
  ];

  const [name, setName] = useState(editing?.name ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [role, setRole] = useState<Role>(editing?.role ?? "editor");
  const [password, setPassword] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);

  const dirty = editing
    ? name !== editing.name || role !== editing.role || password.length > 0
    : true;
  const valid = editing
    ? name.trim().length > 0 && (password.length === 0 || password.length >= 8)
    : name.trim().length > 0 &&
      /.+@.+\..+/.test(email) &&
      password.length >= 8;

  async function submit() {
    if (!valid || !dirty || status === "loading") return;
    setStatus("loading");
    setError(null);
    try {
      if (editing) {
        const patch: Record<string, unknown> = {};
        if (name !== editing.name) patch.name = name.trim();
        if (role !== editing.role) patch.role = role;
        if (password.length > 0) patch.password = password;
        const res = await fetch(`/api/users/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(await errCode(res));
        onSaved({ ...editing, name: name.trim(), role });
      } else {
        const res = await fetch("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, name: name.trim(), role, password }),
        });
        if (!res.ok) throw new Error(await errCode(res));
        const body = (await res.json()) as { user: { id: string; email: string } };
        onSaved({
          id: body.user.id,
          email: body.user.email,
          name: name.trim(),
          role,
          createdAt: Date.now(),
          passkeys: 0,
          lastActiveAt: null,
        });
      }
      setStatus("success");
      setTimeout(onClose, 550);
    } catch (e) {
      setStatus("error");
      setError(describeError(e instanceof Error ? e.message : "", t));
    }
  }

  async function removeUser() {
    if (!editing) return;
    const res = await fetch(`/api/users/${editing.id}`, {
      method: "DELETE",
    }).catch(() => null);
    if (res?.ok) {
      onDeleted(editing.id);
      onClose();
    } else {
      setConfirmRemove(false);
      setError(t("userSheet.error.generic"));
    }
  }

  return (
    <>
      <SheetHeader className="border-b border-black/[0.06] pb-5">
          <SheetTitle className="text-[16px] font-semibold tracking-[-0.01em] text-black/90">
            {editing ? name || editing.name : t("userSheet.addMember")}
          </SheetTitle>
          <SheetDescription className="text-[12.5px] text-black/40">
            {editing ? t("userSheet.updateAccess") : t("userSheet.canSignInNow")}
          </SheetDescription>
        </SheetHeader>

        <form
          className="flex flex-1 flex-col gap-6 overflow-y-auto p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {/* Identity */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel>{t("userSheet.identity")}</SectionLabel>
            <FieldShell label={t("userSheet.nameLabel")}>
              <input
                className={INPUT_CLS}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                autoFocus={!editing}
                required
              />
            </FieldShell>
            {editing ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-medium text-black/55">
                  {t("userSheet.email")}
                </span>
                <button
                  type="button"
                  title={t("userSheet.copyEmail")}
                  onClick={() => {
                    void navigator.clipboard.writeText(editing.email).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    });
                  }}
                  className="group/copy flex h-9 items-center justify-between rounded-[8px] bg-black/[0.03] px-3 text-[13.5px] text-black/60 transition-colors hover:bg-black/[0.05]"
                >
                  <span className="truncate">{editing.email}</span>
                  {copied ? (
                    <Check className="size-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="size-3.5 text-black/30 opacity-0 transition-opacity group-hover/copy:opacity-100" />
                  )}
                </button>
                <span className="text-[11px] text-black/30">
                  {t("userSheet.emailCantChange")}
                </span>
              </div>
            ) : (
              <FieldShell label={t("userSheet.email")}>
                <input
                  className={INPUT_CLS}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@yourteam.com"
                  autoComplete="off"
                  required
                />
              </FieldShell>
            )}
          </div>

          {/* Access */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel>{t("userSheet.access")}</SectionLabel>
            <div role="radiogroup" className="flex flex-col gap-2">
              {roleOptions.map((opt) => {
                const active = role === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={isSelf}
                    onClick={() => setRole(opt.value)}
                    className={cn(
                      "flex flex-col gap-0.5 rounded-[10px] border px-3.5 py-2.5 text-left transition-[border-color,box-shadow,transform]",
                      active
                        ? "border-black/25 shadow-[0_0_0_3px_rgba(0,0,0,0.04)]"
                        : "border-black/[0.08] hover:border-black/20",
                      isSelf
                        ? "cursor-not-allowed opacity-60"
                        : "active:scale-[0.99]",
                    )}
                  >
                    <span className="flex items-center justify-between text-[13px] font-medium text-black/80">
                      {opt.title}
                      {active && <Check className="size-3.5 text-black/55" />}
                    </span>
                    <span className="text-[11.5px] leading-relaxed text-black/40">
                      {opt.hint}
                    </span>
                  </button>
                );
              })}
            </div>
            {isSelf && (
              <span className="text-[11px] text-black/30">
                {t("userSheet.cantChangeOwnRole")}
              </span>
            )}
          </div>

          {/* Security */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel>{t("userSheet.security")}</SectionLabel>
            {editing && (
              <div className="flex h-9 items-center justify-between rounded-[8px] bg-black/[0.03] px-3 text-[13px] text-black/60">
                <span className="flex items-center gap-2">
                  <FaceIdIcon className="size-4 text-black/35" />
                  {t("userSheet.passkeys")}
                </span>
                <span className="tabular-nums">
                  {editing.passkeys > 0 ? editing.passkeys : t("userSheet.none")}
                </span>
              </div>
            )}
            {editing && !resetOpen ? (
              <button
                type="button"
                onClick={() => setResetOpen(true)}
                className="w-fit text-[12.5px] text-black/45 underline-offset-2 transition-colors hover:text-black/75 hover:underline"
              >
                {t("userSheet.resetPassword")}
              </button>
            ) : (
              <FieldShell
                label={
                  editing
                    ? t("userSheet.newPasswordLabel")
                    : t("userSheet.passwordLabel")
                }
              >
                <input
                  className={INPUT_CLS}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("userSheet.minChars")}
                  autoComplete="new-password"
                  minLength={8}
                  required={!editing}
                />
              </FieldShell>
            )}
          </div>

          {/* Danger zone(編他人才有)*/}
          {editing && !isSelf && (
            <div className="mt-2 flex flex-col gap-2 border-t border-black/[0.06] pt-5">
              <SectionLabel tone="danger">{t("userSheet.dangerZone")}</SectionLabel>
              {confirmRemove ? (
                <div className="flex items-center justify-between rounded-[10px] border border-red-600/20 bg-red-50 px-3.5 py-2.5">
                  <span className="text-[12.5px] text-red-700">
                    {t("userSheet.removeConfirm", { name: editing.name })}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(false)}
                      className="rounded-[6px] px-2 py-1 text-[12px] text-black/50 transition-colors hover:bg-black/[0.05]"
                    >
                      {t("userSheet.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeUser()}
                      className="rounded-[6px] bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white transition-[background-color,transform] hover:bg-red-700 active:scale-[0.96]"
                    >
                      {t("userSheet.remove")}
                    </button>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRemove(true)}
                  className="w-fit rounded-[8px] border border-red-600/20 px-3 py-1.5 text-[12.5px] font-medium text-red-600 transition-[background-color,transform] hover:bg-red-50 active:scale-[0.96]"
                >
                  {t("userSheet.removeMemberLabel")}
                </button>
              )}
              <span className="text-[11px] text-black/30">
                {t("userSheet.sessionsEnd")}
              </span>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700"
            >
              {error}
            </p>
          )}
        </form>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-black/[0.06]">
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 items-center rounded-[8px] px-3.5 text-[13px] font-medium text-black/50 transition-colors hover:bg-black/[0.05] hover:text-black/75"
          >
            {t("userSheet.cancel")}
          </button>
          <StatusButton
            size="md"
            status={status === "error" ? "idle" : status}
            label={editing ? t("userSheet.saveChanges") : t("userSheet.createMember")}
            onClick={() => void submit()}
            disabled={!dirty || !valid}
          />
        </SheetFooter>

      {/* edit 模式的 role 徽章預覽,放 header 右側視覺錨點 */}
      {editing && (
        <span className="pointer-events-none absolute top-[3.75rem] right-6">
          <RolePill
            role={role}
            label={
              role === "admin"
                ? t("userSheet.roleAdmin")
                : t("userSheet.roleEditor")
            }
          />
        </span>
      )}
    </>
  );
}

function SectionLabel({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <h3
      className={cn(
        "text-[11px] font-semibold tracking-[0.06em] uppercase",
        tone === "danger" ? "text-red-600/70" : "text-black/35",
      )}
    >
      {children}
    </h3>
  );
}

async function errCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `http_${res.status}`;
}

// API error slug → 使用者可讀訊息(slug 恆為英文,顯示文字走字典)。
function describeError(code: string, t: ReturnType<typeof useT>): string {
  switch (code) {
    case "email_exists":
      return t("userSheet.error.emailExists");
    case "cannot_change_own_role":
      return t("userSheet.error.cantChangeOwnRole");
    case "invalid_input":
      return t("userSheet.error.invalidFields");
    default:
      return t("userSheet.error.generic");
  }
}
