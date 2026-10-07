"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ArrowRight, ChevronDown, ChevronRight, CircleAlert, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import {
  NO_SETTINGS_STATUS,
  settingsHref,
  type SettingsNavField,
  type SettingsNavGroup,
  type SettingsNavItem,
  type SettingsNavLink,
  type SettingsNavStatus,
} from "./settings-nav";
import {
  firstSearchTarget,
  searchSettingsNav,
  type SettingsFieldHit,
  type SettingsSearchHit,
} from "./settings-search";

// 設定頁左邊那一欄:搜尋框 + 每一區的清單(照原本四個分頁分組)+ 最後連到帳戶頁的連結。
// 寬螢幕停在畫面左邊;窄螢幕(lg 以下)收成搜尋框加一顆顯示目前這一區的按鈕,按了才展開清單。
// 兩種排法是同一份 DOM,只靠 CSS 切換,伺服器畫出來的就對。
//
// 列的尺寸與字級跟側欄(AdminSidebar)同一套;選中的那一列是白色小卡,其餘只在滑過時換顏色。
// 每一列都是真的連結(網址帶 ?tab= / ?section=),所以可以開新分頁、複製連結;
// 一般點擊則留在原頁換右邊的內容(onSelect),沒存的修改不會不見。

interface SettingsNavProps {
  groups: readonly SettingsNavGroup[];
  /** 清單最後「去別頁」的連結(帳戶頁)。 */
  links: readonly SettingsNavLink[];
  selected: SettingsNavItem | null;
  /** 清單項目的 key → 要畫的標記。 */
  status: Readonly<Record<string, SettingsNavStatus>>;
  /** 底部的儲存列浮上來時讓出位置,清單最後幾列才不會被蓋住。 */
  saveBarVisible: boolean;
  onSelect: (item: SettingsNavItem, field?: SettingsNavField) => void;
}

const ROW =
  "relative flex min-h-8 w-full min-w-0 scroll-my-2 items-center gap-x-2 rounded-[calc(8px*var(--admin-radius-scale,1))] px-2.5 py-1 text-[13px] font-medium outline-none transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:shadow-[inset_0_0_0_2px_var(--admin-accent)]";
const ROW_IDLE = "text-ink/55 hover:bg-ink/[0.03] hover:text-ink/90";
const ROW_CURRENT =
  "bg-surface text-ink/90 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(20,18,22,0.055),0_1px_2px_-1px_rgba(20,18,22,0.06),0_3px_10px_-4px_rgba(30,20,50,0.08))]";

// 注音/拼音選字中的按鍵是輸入法的。Safari 在選字的 Enter 送到這裡之前就先結束組字
// (isComposing 已經是 false),只剩 keyCode 229 認得出來。
function isImeKey(event: KeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** 上下鍵在搜尋框與清單各列之間移動時認的記號。 */
const ROW_MARK = { "data-settings-nav-row": "" };

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

// 「要注意」與「未儲存」用不同的形狀(圖示、圓點),不只靠顏色分。兩個都是靜態的。
function StatusMarks({ status }: { status: SettingsNavStatus }) {
  const t = useT();
  const alert = status.error
    ? t("settingsNav.hasError")
    : status.attention
      ? t("settingsNav.needsAttention")
      : null;
  if (!alert && !status.unsaved) return null;
  return (
    <span className="ms-auto flex shrink-0 items-center gap-x-1.5 ps-1">
      {alert && (
        <span title={alert} className={cn("flex", status.error ? "text-red-600" : "text-amber-600")}>
          <CircleAlert aria-hidden className="size-3.5" />
          <span className="sr-only"> {alert}</span>
        </span>
      )}
      {status.unsaved && (
        <span title={t("settingsNav.unsaved")} className="flex size-3.5 items-center justify-center">
          <span aria-hidden className="size-1.5 rounded-full bg-(--admin-accent)" />
          <span className="sr-only"> {t("settingsNav.unsaved")}</span>
        </span>
      )}
    </span>
  );
}

export function SettingsNav({
  groups,
  links,
  selected,
  status,
  saveBarVisible,
  onSelect,
}: SettingsNavProps) {
  const t = useT();
  const router = useRouter();
  const baseId = useId();
  const searchId = `${baseId}-search`;
  const listId = `${baseId}-list`;
  const searchRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // query 是輸入框裡的字;search 是拿來篩選的字。組字到一半(還沒選字的注音)不篩選,
  // 不然每打一個符號清單就閃一次「找不到」。
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  // 窄螢幕:清單有沒有展開(寬螢幕永遠展開,這個值用不到)。
  const [open, setOpen] = useState(false);

  // 選到的那一列不在清單看得到的範圍時(用連結直接開到後面的區、從搜尋結果選了一區),捲進來。
  // 只捲清單自己:block "nearest" 在已經看得到時不動。
  const selectedKey = selected?.key;
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedKey, search]);

  const result = searchSettingsNav(groups, links, search);
  const shownLinks = result ? result.links : links;
  const hasRows = result ? result.groups.length > 0 : groups.length > 0;
  const selectedGroup = selected ? groups.find((group) => group.area === selected.area) : undefined;

  function choose(item: SettingsNavItem, field?: SettingsNavField) {
    const active = document.activeElement;
    onSelect(item, field);
    setOpen(false);
    // 窄螢幕選完清單會收起來:焦點原本在清單裡的話,交給那顆顯示目前這一區的按鈕,
    // 不然焦點會跟著消失的那一列掉回頁面最上面。選欄位時由內容那邊把焦點放到欄位上。
    if (!field && active && listRef.current?.contains(active) && toggleRef.current?.offsetParent) {
      toggleRef.current.focus();
    }
  }

  function onRowClick(event: MouseEvent<HTMLAnchorElement>, item: SettingsNavItem, field?: SettingsNavField) {
    // 開新分頁、複製連結這些交給瀏覽器;一般點擊留在原頁換內容。
    if (!isPlainClick(event)) return;
    event.preventDefault();
    choose(item, field);
  }

  // 去別頁的連結(帳戶頁)也是真的 <a>,一般點擊走前端路由(不整頁重新載入)。
  // 不用 next/link:它在測試環境載不起來,而每個畫設定頁的測試都會經過這個元件。
  function onLinkClick(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    router.push(href);
  }

  // 清掉搜尋回到整張清單;窄螢幕順便把清單收回去。先 focus 再改 state:focus 會觸發
  // 下面的 onFocus(把清單打開),要讓這裡的「收起來」是最後一個。
  function clearSearch() {
    searchRef.current?.focus();
    setQuery("");
    setSearch("");
    setOpen(false);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (isImeKey(event)) return;
    if (event.key === "Escape" && query) {
      event.preventDefault();
      clearSearch();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const target = result ? firstSearchTarget(result) : null;
    if (!target) return;
    if (target.kind === "link") router.push(target.link.href);
    else choose(target.item, target.field);
  }

  // 上下鍵:搜尋框 ↔ 清單各列。Tab 照常一列一列走。
  function onArrowKeys(event: KeyboardEvent<HTMLElement>) {
    if (isImeKey(event)) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const active = document.activeElement;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-settings-nav-row]"),
    ).filter((row) => row.offsetParent !== null);
    const index = rows.findIndex((row) => row === active);
    const inSearch = active === searchRef.current;
    if (index === -1 && !inSearch) return;
    if (event.key === "ArrowDown") {
      const next = rows[index + 1];
      if (!next) return;
      event.preventDefault();
      next.focus();
      return;
    }
    if (inSearch) return;
    event.preventDefault();
    (index === 0 ? searchRef.current : rows[index - 1])?.focus();
  }

  function renderRow(item: SettingsNavItem) {
    const current = item.key === selected?.key;
    return (
      <a
        {...ROW_MARK}
        href={settingsHref(groups, item)}
        aria-current={current ? "page" : undefined}
        onClick={(event) => onRowClick(event, item)}
        className={cn(ROW, current ? ROW_CURRENT : ROW_IDLE)}
      >
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        <StatusMarks status={status[item.key] ?? NO_SETTINGS_STATUS} />
      </a>
    );
  }

  function renderFieldRow(item: SettingsNavItem, hit: SettingsFieldHit) {
    return (
      <li key={hit.field.fullKey}>
        <a
          {...ROW_MARK}
          href={`${settingsHref(groups, item)}#${hit.field.controlId}`}
          onClick={(event) => onRowClick(event, item, hit.field)}
          className={cn(ROW, ROW_IDLE, "min-h-7 flex-col items-start gap-y-0.5 text-[12.5px] font-normal")}
        >
          <span className="max-w-full break-words">{hit.field.label}</span>
          {hit.matchedIn === "description" && (
            <span className="line-clamp-2 max-w-full break-words text-[11.5px] leading-snug text-ink/40">
              {hit.field.description}
            </span>
          )}
        </a>
      </li>
    );
  }

  function renderHit(hit: SettingsSearchHit) {
    return (
      <li key={hit.item.key} className="flex flex-col gap-y-0.5">
        {renderRow(hit.item)}
        {hit.fields.length > 0 && (
          <ul aria-label={hit.item.title} className="ms-2.5 flex flex-col gap-y-0.5 border-s border-ink/[0.08] ps-1.5">
            {hit.fields.map((field) => renderFieldRow(hit.item, field))}
          </ul>
        )}
      </li>
    );
  }

  // 分類底下只有一區、名字又跟分類一樣(風格、宣告式):不重複畫一行標題。
  function renderGroup(area: string, label: string, rows: ReactNode) {
    const whole = groups.find((group) => group.area === area);
    const lone = whole?.items.length === 1 && whole.items[0].title === label;
    const headingId = `${baseId}-${area}`;
    return (
      <li key={area} className="flex flex-col gap-y-0.5">
        {!lone && (
          <p id={headingId} className="px-2.5 pb-0.5 text-[11.5px] font-medium text-ink/40">
            {label}
          </p>
        )}
        <ul
          aria-labelledby={lone ? undefined : headingId}
          aria-label={lone ? label : undefined}
          className="flex flex-col gap-y-0.5"
        >
          {rows}
        </ul>
      </li>
    );
  }

  return (
    <nav
      aria-label={t("settingsNav.label")}
      onKeyDown={onArrowKeys}
      className={cn(
        "flex min-w-0 flex-col gap-y-3 lg:sticky lg:top-6 lg:self-start",
        // 高度扣掉清單上面的頁首與「設定」標題(頁面還沒往下捲時清單是從那底下開始的),
        // 不然清單最後幾列會掉到畫面外;儲存列浮上來時再多讓出它的高度。
        saveBarVisible ? "lg:max-h-[calc(100dvh-17rem)]" : "lg:max-h-[calc(100dvh-11rem)]",
      )}
    >
      <div className="relative flex shrink-0 items-center">
        <label htmlFor={searchId} className="sr-only">
          {t("settingsNav.searchLabel")}
        </label>
        <Search aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 text-ink/35" />
        <input
          ref={searchRef}
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!(event.nativeEvent as InputEvent).isComposing) setSearch(event.target.value);
            setOpen(true);
          }}
          // 選好字才篩選。選字之後有的瀏覽器會再送一次 input、有的不會,所以這裡也接。
          onCompositionEnd={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
          // 窄螢幕:清單收著的時候回到搜尋框,打過的字的結果要再出現。
          onFocus={() => {
            if (query) setOpen(true);
          }}
          placeholder={t("settingsNav.searchPlaceholder")}
          maxLength={100}
          autoComplete="off"
          aria-controls={listId}
          className={cn(
            "h-9 w-full min-w-0 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-surface pr-8 pl-8 text-[13px] text-ink/80 lg:h-8",
            "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] placeholder:text-ink/35",
            // 同頂欄搜尋框的內框線,再加一圈淡的外框:這一欄裡 focus 要一眼看得出來。
            "transition-shadow duration-150 focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.3),0_0_0_3px_rgba(0,0,0,0.08)]",
            "[&::-webkit-search-cancel-button]:hidden",
          )}
        />
        {query ? (
          <button
            type="button"
            aria-label={t("settingsNav.clearSearch")}
            onClick={clearSearch}
            className="absolute right-1.5 flex size-6 items-center justify-center rounded-[calc(5px*var(--admin-radius-scale,1))] text-ink/35 outline-none transition-colors duration-150 hover:bg-ink/[0.05] hover:text-ink/70 focus-visible:shadow-[inset_0_0_0_2px_var(--admin-accent)]"
          >
            <X aria-hidden className="size-3" />
          </button>
        ) : null}
      </div>

      {/* 放在會收起來的清單外面:窄螢幕清單收著時,讀屏照樣聽得到「找不到」。 */}
      <p
        role="status"
        className={result?.empty ? "px-2.5 text-[12.5px] leading-relaxed break-words text-ink/50" : "sr-only"}
      >
        {result?.empty ? t("settingsNav.noResults", { q: search.trim() }) : ""}
      </p>

      {selected && (
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
          className="flex h-9 w-full min-w-0 shrink-0 items-center gap-x-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-surface px-3 text-start text-[13px] font-medium text-ink/85 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] outline-none transition-colors duration-150 hover:text-ink focus-visible:shadow-[inset_0_0_0_2px_var(--admin-accent)] lg:hidden"
        >
          <span className="sr-only">{t("settingsNav.choose")} </span>
          {selectedGroup && selectedGroup.label !== selected.title && (
            <>
              <span className="max-w-[40%] shrink-0 truncate text-ink/45">{selectedGroup.label}</span>
              <ChevronRight aria-hidden className="size-3 shrink-0 text-ink/30" />
            </>
          )}
          <span className="min-w-0 flex-1 truncate">{selected.title}</span>
          <StatusMarks status={status[selected.key] ?? NO_SETTINGS_STATUS} />
          <ChevronDown
            aria-hidden
            className={cn("size-3.5 shrink-0 text-ink/35 transition-transform duration-150 ease-out", open && "rotate-180")}
          />
        </button>
      )}

      <div
        ref={listRef}
        id={listId}
        className={cn(
          // 負邊距 + 內距:選中那一列的陰影不會被捲動區域的邊切掉。
          "-m-1 min-w-0 flex-col gap-y-4 p-1 lg:flex lg:min-h-0 lg:overflow-y-auto",
          open ? "flex" : "hidden",
        )}
      >
        {hasRows && (
          <ul className="flex flex-col gap-y-4">
            {result
              ? result.groups.map((group) => renderGroup(group.area, group.label, group.hits.map(renderHit)))
              : groups.map((group) =>
                  renderGroup(
                    group.area,
                    group.label,
                    group.items.map((item) => <li key={item.key}>{renderRow(item)}</li>),
                  ),
                )}
          </ul>
        )}

        {shownLinks.length > 0 && (
          // 上面有清單時用一條線隔開:這是去別頁的連結,不是設定的其中一區。
          <ul className={cn("flex flex-col gap-y-0.5", hasRows && "border-t border-ink/[0.07] pt-3")}>
            {shownLinks.map((link) => (
              <li key={link.id}>
                <a
                  {...ROW_MARK}
                  href={link.href}
                  onClick={(event) => onLinkClick(event, link.href)}
                  className={cn(ROW, ROW_IDLE, "items-start py-1.5")}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-y-0.5">
                    <span className="truncate">{link.title}</span>
                    <span className="break-words text-[11.5px] font-normal leading-snug text-ink/40">
                      {link.description}
                    </span>
                  </span>
                  <ArrowRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ink/30" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
