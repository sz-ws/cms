"use client";

import { Fragment, useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
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
import { AdminLink } from "@/components/admin/AdminLink";
import { cn } from "@/lib/utils";
import {
  RolePill,
  applyRoleChoice,
  roleChoiceBody,
  type RoleOption,
  type UserRecord,
} from "./UsersTable";
import { useT } from "@/lib/i18n/I18nProvider";

export type SheetMode =
  | { mode: "create" }
  | { mode: "edit"; user: UserRecord };

type Role = "admin" | "editor" | "guest";
type RoleChoice = Role | `role:${string}`;

function FieldShell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-ink/55">{label}</span>
      {children}
    </label>
  );
}

const INPUT_CLS =
  "h-9 w-full rounded-[calc(8px*var(--admin-radius-scale,1))] border border-ink/10 bg-surface px-3 text-[13.5px] text-ink/85 transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-ink/25 focus:border-ink/30 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.05)]";

// /admin/users 的編輯/新增 sidebar(core-native「設定從側邊滑出」的體例)。
// 殼常駐、open 由 mode 是否為 null 驅動 —— 條件式 mount + open=true 會讓 base-ui
// 跳過 starting-style,面板瞬間出現;常駐切 open 才有進退場動畫。
// held 保留最後一個非 null mode,退場動畫期間內容不消失;session key 讓每次
// 重新打開時表單 state 全新(避免 effect+setState 重置)。
export function UserSheet({
  mode,
  roles,
  selfId,
  onClose,
  onSaved,
  onDeleted,
}: {
  mode: SheetMode | null;
  /** 1.50.0:自訂角色。 */
  roles: RoleOption[];
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
            roles={roles}
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
  roles,
  selfId,
  onClose,
  onSaved,
  onDeleted,
}: {
  mode: SheetMode;
  roles: RoleOption[];
  selfId: string;
  onClose: () => void;
  onSaved: (u: UserRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useT();
  const editing = mode.mode === "edit" ? mode.user : null;
  const isSelf = editing?.id === selfId;

  const roleOptions: { value: RoleChoice; title: string; hint: string }[] = [
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
  const [choice, setChoice] = useState<RoleChoice>(
    editing ? (editing.staffRoleId ? `role:${editing.staffRoleId}` : editing.role) : "editor",
  );
  const initialChoice: RoleChoice | null = editing
    ? editing.staffRoleId
      ? `role:${editing.staffRoleId}`
      : editing.role
    : null;
  // 1.50.0:自訂角色排在預設角色後面,說明寫它打得開幾個後台頁。
  const customOptions: { value: RoleChoice; title: string; hint: string }[] = roles.map((r) => ({
    value: `role:${r.id}`,
    title: r.name,
    hint:
      r.pages === 0
        ? t("userSheet.pagesNone")
        : r.pages === 1
          ? t("userSheet.pagesCount.one")
          : t("userSheet.pagesCount.other", { n: r.pages }),
  }));
  const picked = applyRoleChoice(choice);
  const [password, setPassword] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);

  const dirty = editing
    ? name !== editing.name || choice !== initialChoice || password.length > 0
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
        if (choice !== initialChoice) Object.assign(patch, roleChoiceBody(choice));
        if (password.length > 0) patch.password = password;
        const res = await fetch(`/api/users/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(await errCode(res));
        onSaved({ ...editing, name: name.trim(), ...picked });
      } else {
        const res = await fetch("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            name: name.trim(),
            // 自訂角色也要帶 role(schema 必填);server 看到 staffRoleId 會寫成 guest。
            role: picked.role,
            ...(picked.staffRoleId ? { staffRoleId: picked.staffRoleId } : {}),
            password,
          }),
        });
        if (!res.ok) throw new Error(await errCode(res));
        const body = (await res.json()) as { user: { id: string; email: string } };
        onSaved({
          id: body.user.id,
          email: body.user.email,
          name: name.trim(),
          ...picked,
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
      <SheetHeader className="border-b border-ink/[0.06] pb-5">
          <SheetTitle className="text-[16px] font-semibold tracking-[-0.01em] text-ink/90">
            {editing ? name || editing.name : t("userSheet.addMember")}
          </SheetTitle>
          <SheetDescription className="text-[12.5px] text-ink/40">
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
                <span className="text-[12.5px] font-medium text-ink/55">
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
                  className="group/copy flex h-9 items-center justify-between rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink/[0.03] px-3 text-[13.5px] text-ink/60 transition-colors hover:bg-ink/[0.05]"
                >
                  <span className="truncate">{editing.email}</span>
                  {copied ? (
                    <Check className="size-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="size-3.5 text-ink/30 opacity-0 transition-opacity group-hover/copy:opacity-100" />
                  )}
                </button>
                <span className="text-[11px] text-ink/30">
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
              {[...roleOptions, ...customOptions].map((opt, index) => {
                const active = choice === opt.value;
                return (
                  <Fragment key={opt.value}>
                    {/* 1.50.0:自訂角色接在預設角色後面,前面一行小標。 */}
                    {index === roleOptions.length && (
                      <span className="mt-2 text-[11.5px] font-medium text-ink/40">
                        {t("userSheet.customRoles")}
                      </span>
                    )}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={isSelf}
                      onClick={() => setChoice(opt.value)}
                      className={cn(
                        "flex flex-col gap-0.5 rounded-[calc(10px*var(--admin-radius-scale,1))] border px-3.5 py-2.5 text-left transition-[border-color,box-shadow,transform]",
                        active
                          ? "border-ink/25 shadow-[0_0_0_3px_rgba(0,0,0,0.04)]"
                          : "border-ink/[0.08] hover:border-ink/20",
                        isSelf
                          ? "cursor-not-allowed opacity-60"
                          : "active:scale-[0.99]",
                      )}
                    >
                      <span className="flex items-center justify-between text-[13px] font-medium text-ink/80">
                        {opt.title}
                        {active && <Check className="size-3.5 text-ink/55" />}
                      </span>
                      {/* 中文說明寫在一行放得下的長度(約 25 字);英文或更窄的畫面
                          折行時,text-pretty 避免最後一行只剩一兩個字。 */}
                      <span className="text-[11.5px] leading-relaxed text-pretty text-ink/40">
                        {opt.hint}
                      </span>
                    </button>
                  </Fragment>
                );
              })}
            </div>
            {isSelf && (
              <span className="text-[11px] text-ink/30">
                {t("userSheet.cantChangeOwnRole")}
              </span>
            )}
            <AdminLink
              href="/admin/roles"
              className="inline-flex w-fit items-center gap-0.5 text-[12.5px] text-ink/55 underline decoration-ink/20 underline-offset-4 transition-colors hover:text-ink/85 hover:decoration-ink/40"
            >
              {t("userSheet.manageRoles")}
              <ChevronRight aria-hidden className="size-3.5" />
            </AdminLink>
          </div>

          {/* Security */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel>{t("userSheet.security")}</SectionLabel>
            {editing && (
              <div className="flex h-9 items-center justify-between rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink/[0.03] px-3 text-[13px] text-ink/60">
                <span className="flex items-center gap-2">
                  <FaceIdIcon className="size-4 text-ink/35" />
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
                className="w-fit text-[12.5px] text-ink/45 underline-offset-2 transition-colors hover:text-ink/75 hover:underline"
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
            <div className="mt-2 flex flex-col gap-2 border-t border-ink/[0.06] pt-5">
              <SectionLabel tone="danger">{t("userSheet.dangerZone")}</SectionLabel>
              {confirmRemove ? (
                <div className="flex items-center justify-between rounded-[calc(10px*var(--admin-radius-scale,1))] border border-red-600/20 bg-red-50 px-3.5 py-2.5">
                  <span className="text-[12.5px] text-red-700">
                    {t("userSheet.removeConfirm", { name: editing.name })}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(false)}
                      className="rounded-[calc(6px*var(--admin-radius-scale,1))] px-2 py-1 text-[12px] text-ink/50 transition-colors hover:bg-ink/[0.05]"
                    >
                      {t("userSheet.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeUser()}
                      className="rounded-[calc(6px*var(--admin-radius-scale,1))] bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white transition-[background-color,transform] hover:bg-red-700 active:scale-[0.96]"
                    >
                      {t("userSheet.remove")}
                    </button>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRemove(true)}
                  className="w-fit rounded-[calc(8px*var(--admin-radius-scale,1))] border border-red-600/20 px-3 py-1.5 text-[12.5px] font-medium text-red-600 transition-[background-color,transform] hover:bg-red-50 active:scale-[0.96]"
                >
                  {t("userSheet.removeMemberLabel")}
                </button>
              )}
              <span className="text-[11px] text-ink/30">
                {t("userSheet.sessionsEnd")}
              </span>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-[calc(8px*var(--admin-radius-scale,1))] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700"
            >
              {error}
            </p>
          )}
        </form>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-ink/[0.06]">
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 items-center rounded-[calc(8px*var(--admin-radius-scale,1))] px-3.5 text-[13px] font-medium text-ink/50 transition-colors hover:bg-ink/[0.05] hover:text-ink/75"
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
            role={picked.role}
            custom={picked.staffRoleId !== null}
            label={
              picked.staffRoleId
                ? (roles.find((r) => r.id === picked.staffRoleId)?.name ?? t("userSheet.roleGuest"))
                : picked.role === "admin"
                  ? t("userSheet.roleAdmin")
                  : picked.role === "guest"
                    ? t("userSheet.roleGuest")
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
        tone === "danger" ? "text-red-600/70" : "text-ink/35",
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
    case "role_not_found":
      return t("userSheet.error.roleNotFound");
    default:
      return t("userSheet.error.generic");
  }
}
