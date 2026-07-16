"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import {
  Check,
  ChevronDown,
  Copy,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  CoreTable,
  RowIconButton,
  type CoreColumn,
} from "@/components/admin/core-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FaceIdIcon } from "@/components/ui/face-id-icon";
import { cn } from "@/lib/utils";
import { relativeTimeWords } from "@/lib/relative-time";
import { UserSheet, type SheetMode } from "./UserSheet";
import { useT, useLocale } from "@/lib/i18n/I18nProvider";
import type { MessageKey, Locale } from "@/lib/i18n";

// ---- row 資料形狀(page.tsx 專用查詢,不動共用 SessionUser)----

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: "admin" | "editor" | "guest";
  createdAt: number;
  passkeys: number;
  /** 最近一次登入(sessions MAX(created_at));從未登入 = null。 */
  lastActiveAt: number | null;
}

// ---- 欄位定義(資料驅動;這是 core-native surface 的延伸點)----
// 之後 extension 要往 users 表格塞欄位(例如「最後登入」「內容數」),形狀就是
// 這個 ColumnDef:加一筆定義、possible optional,不用改 render 迴圈。
// (目前尚未開放 manifest 貢獻;先把形狀立好,對齊 dashboardCards 的先例。)

interface ColumnCtx {
  selfId: string;
  now: number;
  /** cell 內的就地變更(如 role 切換)回寫父層列表 —— 單一資料真相在 UsersTable。 */
  onUserChanged: (u: UserRecord) => void;
  /** COLUMNS 是 module 常數,cell 不是元件不能自己 useT —— t/locale 由表格層注入。 */
  t: ReturnType<typeof useT>;
  locale: Locale;
}

interface ColumnDef {
  key: string;
  /** i18n key —— 表頭與 Display 選單都經 t() 渲染。 */
  label: MessageKey;
  /** optional 欄位進「Display」選單,可被使用者關掉。 */
  optional?: boolean;
  defaultVisible: boolean;
  sortable?: boolean;
  sortValue?: (u: UserRecord) => string | number;
  thClass?: string;
  tdClass?: string;
  render: (u: UserRecord, ctx: ColumnCtx) => React.ReactNode;
}

// email → 固定色相的低飽和底(deterministic,SSR/CSR 一致)。
function emailHue(email: string): number {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) % 360;
  return h;
}

// 琺瑯珠質感:頂光漸層打底、內緣上白高光 + 下暗折射、hue 同色系 hairline,
// 再蓋一層鏡面反光(radial 高光偏左上)。全部 deterministic(hue 來自 email)。
function Avatar({ user }: { user: UserRecord }) {
  const hue = emailHue(user.email);
  return (
    <span
      aria-hidden
      className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-[12px] font-semibold"
      style={{
        backgroundImage: `linear-gradient(180deg, hsl(${hue} 58% 95.5%), hsl(${hue} 46% 87.5%))`,
        color: `hsl(${hue} 34% 36%)`,
        boxShadow: [
          "inset 0 1px 0 rgba(255,255,255,0.85)",
          `inset 0 -1.5px 3px hsl(${hue} 45% 76% / 0.55)`,
          `0 0 0 1px hsl(${hue} 35% 80% / 0.55)`,
          "0 1px 2px rgba(20,15,40,0.06)",
        ].join(", "),
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          backgroundImage:
            "radial-gradient(120% 70% at 30% 16%, rgba(255,255,255,0.6), rgba(255,255,255,0) 46%)",
        }}
      />
      <span className="relative">
        {(user.name || user.email).charAt(0).toUpperCase()}
      </span>
    </span>
  );
}

// pill 同一套琺瑯配方(頂光 + 內高光 + 同色 hairline),admin 走品牌藍、editor 走中性,
// guest 再退一階(幾乎無權限,視覺也最淡)。
export function RolePill({
  role,
  label,
}: {
  role: "admin" | "editor" | "guest";
  label?: string;
}) {
  const admin = role === "admin";
  const guest = role === "guest";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.04em] uppercase",
        admin ? "text-[rgb(76,102,210)]" : guest ? "text-black/35" : "text-black/50",
      )}
      style={{
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0) 58%)",
        backgroundColor: admin
          ? "rgba(86,114,228,0.13)"
          : guest
            ? "rgba(0,0,0,0.03)"
            : "rgba(0,0,0,0.05)",
        boxShadow: admin
          ? "inset 0 1px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(86,114,228,0.18), 0 1px 1.5px rgba(40,55,130,0.08)"
          : "inset 0 1px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(0,0,0,0.06), 0 1px 1.5px rgba(0,0,0,0.04)",
      }}
    >
      {label ?? role}
    </span>
  );
}

function roleLabel(
  role: "admin" | "editor" | "guest",
  t: ReturnType<typeof useT>,
): string {
  if (role === "admin") return t("usersTable.roleAdmin");
  if (role === "guest") return t("usersTable.roleGuest");
  return t("usersTable.roleEditor");
}

const COLUMNS: ColumnDef[] = [
  {
    key: "member",
    label: "usersTable.member",
    defaultVisible: true,
    sortable: true,
    sortValue: (u) => u.name.toLowerCase(),
    tdClass: "py-3 pr-4",
    render: (u, ctx) => (
      <span className="flex min-w-0 items-center gap-3">
        <Avatar user={u} />
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-black/85">
            <span className="truncate">{u.name}</span>
            {u.id === ctx.selfId && (
              <span className="rounded-full bg-black/[0.05] px-1.5 py-px text-[10px] font-medium text-black/45">
                {ctx.t("usersTable.you")}
              </span>
            )}
          </span>
          {isPlaceholderEmail(u.email) ? (
            // placeholder email(OAuth 帳號拿不到 email)遮罩,不露內部合成字串。
            <span className="text-[12px] text-black/30 italic">
              {ctx.t("usersTable.noEmail")}
            </span>
          ) : (
            <CopyableEmail email={u.email} t={ctx.t} />
          )}
        </span>
      </span>
    ),
  },
  {
    key: "role",
    label: "usersTable.role",
    defaultVisible: true,
    sortable: true,
    sortValue: (u) => u.role,
    render: (u, ctx) => (
      <RoleCell
        user={u}
        self={u.id === ctx.selfId}
        onChanged={ctx.onUserChanged}
        t={ctx.t}
      />
    ),
  },
  {
    key: "passkeys",
    label: "usersTable.passkeys",
    optional: true,
    defaultVisible: true,
    sortable: true,
    sortValue: (u) => u.passkeys,
    render: (u) =>
      u.passkeys > 0 ? (
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-black/55 tabular-nums">
          <FaceIdIcon className="size-3.5 text-black/35" />
          {u.passkeys}
        </span>
      ) : (
        <span className="text-[12.5px] text-black/25">—</span>
      ),
  },
  {
    key: "lastActive",
    label: "usersTable.lastActive",
    optional: true,
    defaultVisible: true,
    sortable: true,
    sortValue: (u) => u.lastActiveAt ?? 0,
    render: (u, ctx) =>
      u.lastActiveAt ? (
        <span
          className="text-[12.5px] whitespace-nowrap text-black/45 tabular-nums"
          title={new Date(u.lastActiveAt).toLocaleString()}
        >
          {relativeTimeWords(u.lastActiveAt, ctx.now, ctx.locale)}
        </span>
      ) : (
        <span className="text-[12.5px] text-black/25">{ctx.t("usersTable.never")}</span>
      ),
  },
  {
    key: "created",
    label: "usersTable.joined",
    optional: true,
    defaultVisible: true,
    sortable: true,
    sortValue: (u) => u.createdAt,
    render: (u, ctx) => (
      <span
        className="text-[12.5px] whitespace-nowrap text-black/45 tabular-nums"
        title={new Date(u.createdAt).toLocaleString()}
      >
        {relativeTimeWords(u.createdAt, ctx.now, ctx.locale)}
      </span>
    ),
  },
  {
    key: "id",
    label: "usersTable.userId",
    optional: true,
    defaultVisible: false,
    render: (u) => (
      <code className="text-[11px] text-black/35">{u.id}</code>
    ),
  },
];

// ---- 欄位可見度:localStorage 為準的小 store(useSyncExternalStore 讀,避免
// effect+setState;同分頁寫入自行通知,跨分頁靠 storage 事件)----

const COL_KEY = "cms.users.columns";
const colListeners = new Set<() => void>();

function subscribeCols(cb: () => void): () => void {
  colListeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === COL_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    colListeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function readColPref(): string | null {
  return localStorage.getItem(COL_KEY);
}

function writeColPref(hidden: string[]): void {
  localStorage.setItem(COL_KEY, JSON.stringify(hidden));
  for (const cb of colListeners) cb();
}

/** 儲存的是「被關掉的 optional 欄位」;新增欄位時預設就是可見,不會被舊偏好蓋掉。 */
function hiddenColumns(pref: string | null): Set<string> {
  if (!pref) return new Set(COLUMNS.filter((c) => !c.defaultVisible).map((c) => c.key));
  try {
    const arr = JSON.parse(pref) as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

// ---- 格內互動元件 ----

function CopyableEmail({ email, t }: { email: string; t: ReturnType<typeof useT> }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(email).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title={t("usersTable.copyEmail")}
      className="group/em relative flex w-fit items-center gap-1 text-[12px] text-black/40 transition-colors before:absolute before:-inset-1.5 hover:text-black/70"
    >
      <span className="truncate">{email}</span>
      {copied ? (
        <Check className="size-3 text-emerald-600" />
      ) : (
        <Copy className="size-3 opacity-0 transition-opacity group-hover/em:opacity-100" />
      )}
    </button>
  );
}

function RoleCell({
  user,
  self,
  onChanged,
  t,
}: {
  user: UserRecord;
  self: boolean;
  onChanged: (u: UserRecord) => void;
  t: ReturnType<typeof useT>;
}) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  // role 的真相住在父層 users 列表(user prop),這裡不留分身 ——
  // 否則就地切換後馬上開編輯 sheet 會拿到舊 role。
  const role = user.role;

  if (self) {
    // 自己的 role 後端擋(cannot_change_own_role),前端直接不給選單。
    return (
      <span title={t("usersTable.cantChangeOwnRole")} className="cursor-not-allowed">
        <RolePill role={role} label={roleLabel(role, t)} />
      </span>
    );
  }

  async function switchRole(next: "admin" | "editor" | "guest") {
    if (next === role) return;
    setFailed(false);
    onChanged({ ...user, role: next }); // 樂觀
    const res = await fetch(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: next }),
    }).catch(() => null);
    if (!res || !res.ok) {
      onChanged(user); // 回滾
      setFailed(true);
    } else {
      router.refresh();
    }
  }

  return (
    <span onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="group/role flex items-center gap-1 rounded-full transition-shadow hover:shadow-[0_0_0_3px_rgba(0,0,0,0.04)] focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.08)] focus-visible:outline-none"
          title={t("usersTable.changeRole")}
        >
          <RolePill role={role} label={roleLabel(role, t)} />
          <ChevronDown className="size-3 text-black/30 opacity-0 transition-opacity group-hover/role:opacity-100" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[9rem]">
          <DropdownMenuRadioGroup
            value={role}
            onValueChange={(v) => void switchRole(v as "admin" | "editor" | "guest")}
          >
            <DropdownMenuRadioItem value="admin">{t("usersTable.roleAdmin")}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="editor">{t("usersTable.roleEditor")}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="guest">{t("usersTable.roleGuest")}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {failed && <span className="text-[11px] text-red-600">{t("usersTable.failed")}</span>}
    </span>
  );
}

// ---- 主表格 ----

export function UsersTable({
  initialUsers,
  selfId,
  now,
}: {
  initialUsers: UserRecord[];
  selfId: string;
  now: number;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  // router.refresh() 帶回的新 server 資料要蓋掉樂觀 state(官方「adjust state when
  // props change」render-time 模式)—— 不然刷新後列表永遠停在第一次的快照。
  const [prevInitial, setPrevInitial] = useState(initialUsers);
  if (initialUsers !== prevInitial) {
    setPrevInitial(initialUsers);
    setUsers(initialUsers);
  }
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const colPref = useSyncExternalStore(subscribeCols, readColPref, () => null);
  const hidden = hiddenColumns(colPref);
  const visibleCols = COLUMNS.filter((c) => !c.optional || !hidden.has(c.key));
  const ctx: ColumnCtx = {
    selfId,
    now,
    t,
    locale,
    onUserChanged: (u) =>
      setUsers((list) => list.map((x) => (x.id === u.id ? u : x))),
  };

  // COLUMNS(module 常數,含 optional 資訊供 ColumnPicker)→ CoreTable 欄位:
  // label 過 t()、render 綁上 ctx。排序由 CoreTable 自己管。
  const columns: CoreColumn<UserRecord>[] = visibleCols.map((c) => ({
    key: c.key,
    label: t(c.label),
    sortable: c.sortable,
    sortValue: c.sortValue,
    thClass: c.thClass,
    tdClass: c.tdClass,
    render: (u) => c.render(u, ctx),
  }));

  async function deleteUser(id: string) {
    setError(null);
    const prev = users;
    setUsers((u) => u.filter((x) => x.id !== id));
    setConfirmDelete(null);
    const res = await fetch(`/api/users/${id}`, { method: "DELETE" }).catch(
      () => null,
    );
    if (!res || !res.ok) {
      setUsers(prev);
      setError(t("usersTable.removeFailed"));
    } else {
      router.refresh();
    }
  }

  const memberCount =
    users.length === 1
      ? t("usersTable.memberCount.one")
      : t("usersTable.memberCount.other", { n: users.length });

  return (
    <div className="flex flex-col gap-4">
      {/* toolbar:數量在左,Display / Add member 在右(頁面 h1 已交代語境,不再包卡)。 */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12.5px] text-black/35 tabular-nums">
          {memberCount}
        </p>
        <div className="flex items-center gap-2">
          <ColumnPicker hidden={hidden} />
          <button
            type="button"
            onClick={() => setSheet({ mode: "create" })}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-full bg-black pr-3.5 pl-3 text-[12.5px] font-medium text-white",
              "transition-[background-color,transform] duration-150 hover:bg-black/85 active:scale-[0.96]",
            )}
          >
            <Plus className="size-3.5" />
            {t("usersTable.addMember")}
          </button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700"
        >
          {error}
        </p>
      )}

      {/* 表格本體:共用 CoreTable(rounded 白底 + hairline ring,窄視窗容器自己
          橫向捲)。編輯中的列上品牌藍 tint 跟右側 sheet 連動。 */}
      <CoreTable
        columns={columns}
        rows={users}
        rowKey={(u) => u.id}
        onRowClick={(u) => setSheet({ mode: "edit", user: u })}
        rowActive={(u) => sheet?.mode === "edit" && sheet.user.id === u.id}
        trailingActions={(u) =>
          confirmDelete === u.id ? (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="rounded-[6px] px-2 py-1 text-[12px] text-black/45 transition-colors hover:bg-black/[0.05]"
              >
                {t("usersTable.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void deleteUser(u.id)}
                className="rounded-[6px] bg-red-600 px-2 py-1 text-[12px] font-medium text-white transition-[background-color,transform] hover:bg-red-700 active:scale-[0.96]"
              >
                {t("usersTable.remove")}
              </button>
            </span>
          ) : (
            <>
              <RowIconButton
                label={t("usersTable.editMember")}
                onClick={() => setSheet({ mode: "edit", user: u })}
              >
                <Pencil className="size-3.5" />
              </RowIconButton>
              {u.id !== selfId && (
                <RowIconButton
                  label={t("usersTable.removeMember")}
                  danger
                  onClick={() => setConfirmDelete(u.id)}
                >
                  <Trash2 className="size-3.5" />
                </RowIconButton>
              )}
            </>
          )
        }
      />

      {/* 常駐 mount:open 切換才有進退場動畫(見 UserSheet 註解)。 */}
      <UserSheet
        mode={sheet}
        selfId={selfId}
        onClose={() => setSheet(null)}
        onSaved={(u) => {
          setUsers((list) => {
            const i = list.findIndex((x) => x.id === u.id);
            if (i === -1) return [...list, u];
            const next = [...list];
            next[i] = u;
            return next;
          });
          router.refresh();
        }}
        onDeleted={(id) => {
          setUsers((list) => list.filter((x) => x.id !== id));
          router.refresh();
        }}
      />
    </div>
  );
}

function ColumnPicker({ hidden }: { hidden: Set<string> }) {
  const t = useT();
  const optional = COLUMNS.filter((c) => c.optional);
  return (
    <Popover>
      <PopoverTrigger
        title={t("usersTable.display")}
        className="flex size-8 items-center justify-center rounded-full text-black/40 transition-colors hover:bg-black/[0.05] hover:text-black/70 focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.08)] focus-visible:outline-none"
      >
        <SlidersHorizontal className="size-4" />
        <span className="sr-only">{t("usersTable.display")}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-black/35 uppercase">
          {t("usersTable.display")}
        </p>
        {optional.map((col) => {
          const on = !hidden.has(col.key);
          return (
            <button
              key={col.key}
              type="button"
              onClick={() => {
                const next = new Set(hidden);
                if (on) next.add(col.key);
                else next.delete(col.key);
                writeColPref([...next]);
              }}
              className="flex w-full items-center justify-between rounded-[7px] px-2 py-1.5 text-[13px] text-black/70 transition-colors hover:bg-black/[0.04]"
            >
              {t(col.label)}
              {on && <Check className="size-3.5 text-black/55" />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
