"use client";

import { startTransition, useOptimistic, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { stableReducer } from "@/lib/optimistic";
import {
  presetAccess,
  type AccessMap,
  type AccessSection,
  type PresetRole,
} from "@/ext/admin-access";
import { SaveBar, SAVE_BAR_SECONDARY_CLASS, SAVE_BUTTON_CLASS } from "@/components/admin/SaveBar";
import { useT } from "@/lib/i18n/I18nProvider";
import { AccessMatrix } from "./AccessMatrix";
import { RoleDetailHeader, RoleDeleteZone } from "./RoleDetailParts";
import {
  applyRolesAction,
  sameDraft,
  setAreaLevel,
  setSectionLevel,
  type RoleDraft,
  type RoleRow,
  type RolesAction,
} from "./roles-draft";

// 角色與權限的工作區:左邊角色清單,右邊矩陣。
//
// 每個角色各自保留未儲存的修改(drafts,以角色 id 為鍵;新角色是 "new"):切去看別的
// 角色不會丟掉改到一半的東西,清單上有未儲存修改的角色標一個點。存檔走樂觀更新
// (useOptimistic + router.refresh(),同成員頁),失敗時列表自己退回。

const PRESETS: readonly PresetRole[] = ["admin", "editor", "guest"];
const NEW_KEY = "new";

type Selection = { kind: "preset"; id: PresetRole } | { kind: "custom"; id: string } | { kind: "new" };

const reduceRoles = stableReducer<RoleRow[], RolesAction>(applyRolesAction);

function keyOf(selection: Selection): string {
  return selection.kind === "preset" ? `preset:${selection.id}` : selection.kind === "new" ? NEW_KEY : selection.id;
}

function initialSelection(initial: string | undefined, roles: readonly RoleRow[]): Selection {
  if (initial && roles.some((role) => role.id === initial)) return { kind: "custom", id: initial };
  if (initial && (PRESETS as readonly string[]).includes(initial)) return { kind: "preset", id: initial as PresetRole };
  return roles.length > 0 ? { kind: "custom", id: roles[0].id } : { kind: "preset", id: "admin" };
}

function rememberSelection(selection: Selection): void {
  const role = selection.kind === "new" ? null : selection.id;
  const url = new URL(window.location.href);
  if (role) url.searchParams.set("role", role);
  else url.searchParams.delete("role");
  window.history.replaceState(null, "", url);
}

async function errorCode(res: Response | null): Promise<string> {
  if (!res) return "network";
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `http_${res.status}`;
}

export function RolesWorkspace({
  sections,
  roles: serverRoles,
  presetCounts,
  initialRole,
}: {
  sections: AccessSection[];
  roles: RoleRow[];
  presetCounts: Record<PresetRole, number>;
  initialRole?: string;
}) {
  const t = useT();
  const router = useRouter();
  const [roles, applyOptimistic] = useOptimistic<RoleRow[], RolesAction>(serverRoles, reduceRoles);
  const [selection, setSelection] = useState<Selection>(() => initialSelection(initialRole, serverRoles));
  const [drafts, setDrafts] = useState<Record<string, RoleDraft>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const presetLabel = (id: PresetRole) =>
    t(id === "admin" ? "usersTable.roleAdmin" : id === "editor" ? "usersTable.roleEditor" : "usersTable.roleGuest");

  // 選到的自訂角色被刪掉(別的分頁)→ 回到管理者。
  const current: Selection =
    selection.kind === "custom" && !roles.some((role) => role.id === selection.id)
      ? { kind: "preset", id: "admin" }
      : selection;
  const key = keyOf(current);

  function baseline(sel: Selection): RoleDraft {
    if (sel.kind === "preset") return { name: presetLabel(sel.id), access: presetAccess(sel.id, sections) };
    if (sel.kind === "new") return { name: "", access: {} };
    const role = roles.find((r) => r.id === sel.id);
    return { name: role?.name ?? "", access: role?.access ?? {} };
  }

  const base = baseline(current);
  const draft = drafts[key] ?? base;
  const readOnly = current.kind === "preset";
  const isNew = current.kind === "new";
  const dirty = isNew || (drafts[key] !== undefined && !sameDraft(drafts[key], base));
  const customRole = current.kind === "custom" ? roles.find((r) => r.id === current.id) : undefined;
  const members = current.kind === "preset" ? presetCounts[current.id] : (customRole?.members ?? 0);

  function select(next: Selection) {
    setSelection(next);
    setError(null);
    rememberSelection(next);
  }

  function edit(change: (access: AccessMap) => AccessMap) {
    if (readOnly) return;
    setDrafts((all) => ({ ...all, [key]: { ...draft, access: change(draft.access) } }));
  }

  function rename(name: string) {
    setDrafts((all) => ({ ...all, [key]: { ...draft, name } }));
  }

  function dropDraft(k: string) {
    setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== k)));
  }

  function startFrom(preset: PresetRole) {
    setDrafts((all) => ({ ...all, [NEW_KEY]: { name: "", access: presetAccess(preset, sections) } }));
    select({ kind: "new" });
  }

  function startBlank() {
    setDrafts((all) => ({ ...all, [NEW_KEY]: { name: "", access: {} } }));
    select({ kind: "new" });
  }

  function discard() {
    dropDraft(key);
    setError(null);
    if (isNew) select(roles.length > 0 ? { kind: "custom", id: roles[0].id } : { kind: "preset", id: "admin" });
  }

  function describe(code: string): string {
    if (code === "name_taken") return t("roles.error.nameTaken");
    return t("roles.error.generic");
  }

  function save() {
    if (saving || readOnly) return;
    const name = draft.name.trim();
    if (!name) {
      setError(t("roles.error.nameRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    const body = JSON.stringify({ name, access: draft.access });
    startTransition(async () => {
      if (current.kind === "custom") {
        applyOptimistic({ kind: "upsert", role: { id: current.id, name, access: draft.access, members } });
        const res = await fetch(`/api/roles/${encodeURIComponent(current.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body,
        }).catch(() => null);
        if (res?.ok) {
          dropDraft(key);
          router.refresh();
        } else setError(describe(await errorCode(res)));
      } else {
        const res = await fetch("/api/roles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }).catch(() => null);
        if (res?.ok) {
          const { role } = (await res.json()) as { role: RoleRow };
          // await 之後已不在原本的 transition 裡:另開一個,新角色在 refresh 回來前就在清單上。
          startTransition(() => {
            applyOptimistic({ kind: "upsert", role });
            router.refresh();
          });
          dropDraft(NEW_KEY);
          select({ kind: "custom", id: role.id });
        } else setError(describe(await errorCode(res)));
      }
      setSaving(false);
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      applyOptimistic({ kind: "remove", id });
      const res = await fetch(`/api/roles/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
      if (res?.ok) {
        dropDraft(id);
        select({ kind: "preset", id: "admin" });
        router.refresh();
      } else setError(t("roles.deleteFailed"));
    });
  }

  const railItem = (sel: Selection, name: string, count: number | null) => {
    const k = keyOf(sel);
    const active = k === key;
    const unsaved = k !== key && drafts[k] !== undefined && (k === NEW_KEY || !sameDraft(drafts[k], baseline(sel)));
    return (
      <li key={k}>
        <button
          type="button"
          aria-current={active ? "true" : undefined}
          onClick={() => select(sel)}
          className={cn(
            "flex w-full items-center justify-between gap-3 rounded-[calc(10px*var(--admin-radius-scale,1))] px-3 py-2 text-left",
            "transition-[background-color,box-shadow,transform] duration-150 active:scale-[0.99]",
            "outline-none focus-visible:shadow-[0_0_0_2px_var(--admin-accent)]",
            active
              ? "bg-surface shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]"
              : "hover:bg-ink/[0.03]",
          )}
        >
          <span className="flex min-w-0 flex-col">
            <span className={cn("truncate text-[13.5px] font-medium", active ? "text-ink/90" : "text-ink/70")}>
              {name || t("roles.add")}
            </span>
            {count !== null && (
              <span className="text-[11.5px] text-ink/35 tabular-nums">
                {count === 0
                  ? t("roles.members.none")
                  : count === 1
                    ? t("roles.members.one")
                    : t("roles.members.other", { n: count })}
              </span>
            )}
          </span>
          {unsaved && (
            <span aria-label={t("roles.unsaved")} className="size-1.5 shrink-0 rounded-full bg-(--admin-accent)" />
          )}
        </button>
      </li>
    );
  };

  return (
    <div className={cn("grid items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]", dirty && "pb-24")}>
      <nav aria-label={t("roles.title")} className="flex flex-col gap-5 lg:sticky lg:top-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="px-3 text-[12px] font-medium text-ink/40">{t("roles.presets")}</h2>
          <ul className="flex flex-col gap-0.5">
            {PRESETS.map((id) => railItem({ kind: "preset", id }, presetLabel(id), presetCounts[id]))}
          </ul>
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="px-3 text-[12px] font-medium text-ink/40">{t("roles.custom")}</h2>
          <ul className="flex flex-col gap-0.5">
            {roles.map((role) => railItem({ kind: "custom", id: role.id }, role.name, role.members))}
            {drafts[NEW_KEY] !== undefined && railItem({ kind: "new" }, drafts[NEW_KEY].name, null)}
          </ul>
          {roles.length === 0 && drafts[NEW_KEY] === undefined && (
            <p className="px-3 text-[12px] text-ink/35">{t("roles.customEmpty")}</p>
          )}
          <button
            type="button"
            onClick={startBlank}
            className="mt-1 flex h-8 w-fit items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-ink/55 transition-[background-color,color,transform] duration-150 hover:bg-ink/[0.04] hover:text-ink/85 active:scale-[0.96]"
          >
            <Plus aria-hidden className="size-3.5" />
            {t("roles.add")}
          </button>
        </div>
      </nav>

      {/* 單層卡片(同成員頁的表格):外面再包一圈玻璃框,「細邊線」風格下會變成兩道邊。 */}
      <section
        aria-label={draft.name || t("roles.add")}
        className="flex flex-col gap-4 rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface px-5 pt-5 pb-3 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))] sm:px-6"
      >
        <RoleDetailHeader
          preset={current.kind === "preset" ? current.id : null}
          name={draft.name}
          members={isNew ? null : members}
          onRename={rename}
          onStartFrom={startFrom}
          autoFocus={isNew}
        />
        <p className="text-[12px] leading-relaxed text-ink/40">{t("roles.levelHint")}</p>
        <AccessMatrix
          sections={sections}
          access={draft.access}
          readOnly={readOnly}
          onArea={(area, level) => edit((access) => setAreaLevel(access, area, level))}
          onSection={(section, level) => edit((access) => setSectionLevel(access, section, level))}
        />
        {customRole && (
          <RoleDeleteZone key={customRole.id} members={customRole.members} onDelete={() => remove(customRole.id)} />
        )}
      </section>

      <SaveBar
        visible={dirty}
        title={isNew ? t("roles.unsavedNew") : t("roles.unsaved")}
        // 新角色還沒有人用,「成員下次開頁面就套用」對它沒有意義。
        note={error ?? (isNew ? undefined : t("roles.saveNote"))}
        alert={error !== null}
      >
        <button type="button" onClick={discard} className={SAVE_BAR_SECONDARY_CLASS}>
          {t("roles.discard")}
        </button>
        <button type="button" onClick={save} disabled={saving} className={SAVE_BUTTON_CLASS}>
          {isNew ? t("roles.create") : t("roles.save")}
          <span aria-hidden className="text-white/70">→</span>
        </button>
      </SaveBar>

      {!dirty && error && (
        <p role="alert" className="text-[12.5px] text-red-600 lg:col-start-2">
          {error}
        </p>
      )}
    </div>
  );
}
