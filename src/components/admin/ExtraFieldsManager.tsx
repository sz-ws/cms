"use client";

import { useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { isImeKeyEvent } from "@/lib/ime";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/index";
import {
  EXTRA_FIELD_KEY_RE,
  EXTRA_FIELD_TYPES,
  EXTRA_FIELDS_SETTING,
  EXTRA_LABEL_MAX,
  MAX_EXTRA_FIELDS,
  type ExtraFieldDef,
  type ExtraFieldType,
  type ExtraFieldsSetting,
} from "@/lib/extra-fields";

// 設定頁的「額外欄位」卡(規則見 lib/extra-fields.ts)。一次編一種內容,整份設定一起存:
// 選單以外的類型(停用中的插件留下的)原封不動跟著存回去,不會因為看不到就被清掉。
//
// 這張卡在 SettingsWorkspace 的 <form> 裡面,所以:按鈕一律 type="button";在輸入框
// 按 Enter 會觸發外層表單送出,在根節點攔掉(組字中的 Enter 是在選字,不攔)。
// 有自己的儲存鈕,不走外層那條儲存列 —— 外層只認得一格一個值的設定。

interface ExtraFieldsContentType {
  type: string;
  label: string;
}

interface ExtraFieldsManagerProps {
  types: ExtraFieldsContentType[];
  initialSetting: ExtraFieldsSetting;
}

interface DraftRow extends ExtraFieldDef {
  /** 只給 React 當 key(代號可以改,不能拿來當 key)。 */
  id: string;
}

type Drafts = Record<string, DraftRow[]>;
type RowError = "label" | "key" | "duplicate";

const TYPE_LABELS: Record<ExtraFieldType, MessageKey> = {
  boolean: "extraFields.type.boolean",
  text: "extraFields.type.text",
  textarea: "extraFields.type.textarea",
  number: "extraFields.type.number",
};

const ERROR_TEXT: Record<RowError, MessageKey> = {
  label: "extraFields.error.label",
  key: "extraFields.error.key",
  duplicate: "extraFields.error.duplicate",
};

const ICON_BUTTON =
  "rounded-[calc(6px*var(--admin-radius-scale,1))] p-1.5 text-ink/35 transition-colors hover:bg-ink/[0.04] hover:text-ink/85 disabled:pointer-events-none disabled:opacity-30";

function toDrafts(setting: ExtraFieldsSetting): Drafts {
  return Object.fromEntries(
    Object.entries(setting).map(([type, defs]) => [
      type,
      defs.map((def, i) => ({ ...def, id: `${type}#${i}` })),
    ]),
  );
}

/** 草稿 → 要存的設定。沒有欄位的類型整個拿掉。 */
function toSetting(drafts: Drafts): ExtraFieldsSetting {
  const out: ExtraFieldsSetting = {};
  for (const [type, rows] of Object.entries(drafts)) {
    if (rows.length === 0) continue;
    out[type] = rows.map((row) => ({
      key: row.key.trim(),
      label: row.label.trim(),
      type: row.type,
      public: row.public,
    }));
  }
  return out;
}

function rowErrors(rows: DraftRow[]): Record<string, RowError> {
  const errors: Record<string, RowError> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!row.label.trim()) errors[row.id] = "label";
    else if (!EXTRA_FIELD_KEY_RE.test(key)) errors[row.id] = "key";
    else if (seen.has(key)) errors[row.id] = "duplicate";
    seen.add(key);
  }
  return errors;
}

export function ExtraFieldsManager({ types, initialSetting }: ExtraFieldsManagerProps) {
  const t = useT();
  const router = useRouter();
  const [drafts, setDrafts] = useState<Drafts>(() => toDrafts(initialSetting));
  const [baseline, setBaseline] = useState(() => JSON.stringify(toSetting(toDrafts(initialSetting))));
  // 先開已經有欄位的那一種,沒有就第一種。
  const [selected, setSelected] = useState<string>(
    () => (types.find((ct) => (initialSetting[ct.type] ?? []).length > 0) ?? types[0])?.type ?? "",
  );
  // 按過一次儲存才開始標錯:剛按「新增欄位」的空白列不該一出現就是紅的。
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = drafts[selected] ?? [];
  const errors = attempted ? rowErrors(rows) : {};
  const next = toSetting(drafts);
  const dirty = JSON.stringify(next) !== baseline;

  function updateRows(change: (rows: DraftRow[]) => DraftRow[]) {
    setDrafts((prev) => ({ ...prev, [selected]: change(prev[selected] ?? []) }));
    setSaved(false);
    setError(null);
  }

  function updateRow(id: string, patch: Partial<ExtraFieldDef>) {
    updateRows((list) => list.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addRow() {
    updateRows((list) => [
      ...list,
      { id: `new#${Date.now()}#${list.length}`, key: "", label: "", type: "text", public: false },
    ]);
  }

  function moveRow(index: number, delta: -1 | 1) {
    updateRows((list) => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      const copy = [...list];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy;
    });
  }

  function removeRow(id: string) {
    updateRows((list) => list.filter((row) => row.id !== id));
  }

  // 外層是設定頁的 <form>:在這張卡的輸入框按 Enter 不該送出整頁設定。
  function blockEnterSubmit(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement && !isImeKeyEvent(e)) {
      e.preventDefault();
    }
  }

  async function save() {
    setAttempted(true);
    setSaved(false);
    // 每一種都驗:錯在別的類型時切過去,不然使用者看不到哪裡要改。
    const broken = Object.keys(drafts).find(
      (type) => Object.keys(rowErrors(drafts[type])).length > 0,
    );
    if (broken) {
      if (broken !== selected) setSelected(broken);
      setError(t("extraFields.fixErrors"));
      return;
    }
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: { [EXTRA_FIELDS_SETTING]: next } }),
      });
      if (res.ok) {
        setBaseline(JSON.stringify(next));
        setAttempted(false);
        setSaved(true);
        router.refresh();
        window.setTimeout(() => setSaved(false), 1200);
      } else if (res.status === 400) {
        setError(t("extraFields.fixErrors"));
      } else if (res.status === 401 || res.status === 403) {
        setError(t("extraFields.notAllowed"));
      } else {
        setError(t("extraFields.saveFailed"));
      }
    } catch {
      setError(t("extraFields.saveFailed"));
    } finally {
      setPending(false);
    }
  }

  // 儲存中由按鈕自己說,這一行只講結果與待存。
  const status =
    error ??
    (saved ? t("extraFields.saved") : dirty && !pending ? t("extraFields.unsaved") : null);

  return (
    <div className="flex flex-col gap-4" onKeyDown={blockEnterSubmit}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-ink/90">
            {t("extraFields.title")}
          </h3>
          <p className="text-[12px] text-ink/40">{t("extraFields.desc")}</p>
        </div>
        {types.length > 0 && (
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <label htmlFor="extra-fields-type" className="shrink-0 text-[13px] font-medium text-ink/55">
              {t("extraFields.contentType")}
            </label>
            <Select
              value={selected}
              onValueChange={(value) => {
                if (typeof value === "string") setSelected(value);
              }}
              // 沒給 items,<SelectValue> 會顯示原始值而不是選項文字。
              items={types.map((ct) => ({ value: ct.type, label: ct.label }))}
            >
              <SelectTrigger
                id="extra-fields-type"
                className="w-full rounded-[calc(8px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85 sm:w-56"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {types.map((ct) => (
                  <SelectItem key={ct.type} value={ct.type}>
                    {ct.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {types.length === 0 ? (
        <p className="rounded-[calc(14px*var(--admin-radius-scale,1))] border border-dashed border-ink/20 p-6 text-center text-[13px] text-ink/45">
          {t("extraFields.noTypes")}
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-[calc(14px*var(--admin-radius-scale,1))] border border-dashed border-ink/20 p-6 text-center text-[13px] text-ink/45">
          {t("extraFields.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div
            aria-hidden
            className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_9.5rem_3.25rem_5.75rem] gap-2 px-3 text-[12px] font-medium text-ink/45 sm:grid"
          >
            <span>{t("extraFields.label")}</span>
            <span>{t("extraFields.key")}</span>
            <span>{t("extraFields.fieldType")}</span>
            <span>{t("extraFields.public")}</span>
            <span />
          </div>
          {rows.map((row, index) => (
            <FieldRow
              key={row.id}
              row={row}
              first={index === 0}
              last={index === rows.length - 1}
              error={errors[row.id]}
              onChange={(patch) => updateRow(row.id, patch)}
              onMove={(delta) => moveRow(index, delta)}
              onRemove={() => removeRow(row.id)}
            />
          ))}
          <div className="flex flex-col gap-0.5 px-1 pt-1 text-[12px] leading-relaxed text-ink/40">
            <p>{t("extraFields.keyHint")}</p>
            <p>{t("extraFields.publicHint")}</p>
          </div>
        </div>
      )}

      {types.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-ink/[0.06] pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={addRow}
            disabled={rows.length >= MAX_EXTRA_FIELDS}
          >
            <Plus className="size-4" />
            {t("extraFields.add")}
          </Button>
          {rows.length >= MAX_EXTRA_FIELDS && (
            <span className="text-[12px] text-ink/40">
              {t("extraFields.limit", { n: MAX_EXTRA_FIELDS })}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            {status && (
              <span
                role={error ? "alert" : "status"}
                className={cn("text-[12px]", error ? "text-red-600" : "text-ink/45")}
              >
                {status}
              </span>
            )}
            <Button type="button" size="sm" onClick={save} disabled={pending || !dirty}>
              {pending ? t("extraFields.saving") : t("extraFields.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface FieldRowProps {
  row: DraftRow;
  first: boolean;
  last: boolean;
  error?: RowError;
  onChange: (patch: Partial<ExtraFieldDef>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

function FieldRow({ row, first, last, error, onChange, onMove, onRemove }: FieldRowProps) {
  const t = useT();
  const errorId = `extra-field-${row.id}-error`;
  const inputClass =
    "h-9 rounded-[calc(8px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85 placeholder:text-ink/25";
  return (
    <div className="flex flex-col gap-1.5 rounded-[calc(10px*var(--admin-radius-scale,1))] border border-ink/10 bg-surface px-3 py-2.5">
      <div className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_9.5rem_3.25rem_5.75rem]">
        <Input
          aria-label={t("extraFields.label")}
          aria-invalid={error === "label" ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={inputClass}
          value={row.label}
          maxLength={EXTRA_LABEL_MAX}
          placeholder={t("extraFields.labelPlaceholder")}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <Input
          aria-label={t("extraFields.key")}
          aria-invalid={error === "key" || error === "duplicate" ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(inputClass, "font-mono text-[13px]")}
          value={row.key}
          maxLength={40}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("extraFields.keyPlaceholder")}
          onChange={(e) => onChange({ key: e.target.value })}
        />
        <Select
          value={row.type}
          onValueChange={(value) => {
            const type = EXTRA_FIELD_TYPES.find((option) => option === value);
            if (type) onChange({ type });
          }}
          items={EXTRA_FIELD_TYPES.map((type) => ({ value: type, label: t(TYPE_LABELS[type]) }))}
        >
          <SelectTrigger
            aria-label={t("extraFields.fieldType")}
            className="w-full rounded-[calc(8px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {EXTRA_FIELD_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(TYPE_LABELS[type])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-[12px] text-ink/55 sm:justify-center">
          <Switch
            checked={row.public}
            onCheckedChange={(checked) => onChange({ public: checked })}
            aria-label={t("extraFields.public")}
          />
          <span className="sm:hidden">{t("extraFields.public")}</span>
        </label>
        <div className="col-span-2 flex items-center justify-end gap-0.5 sm:col-span-1">
          <button type="button" className={ICON_BUTTON} disabled={first} onClick={() => onMove(-1)} title={t("dxField.moveUp")} aria-label={t("dxField.moveUp")}>
            <ArrowUp className="size-4" />
          </button>
          <button type="button" className={ICON_BUTTON} disabled={last} onClick={() => onMove(1)} title={t("dxField.moveDown")} aria-label={t("dxField.moveDown")}>
            <ArrowDown className="size-4" />
          </button>
          <button
            type="button"
            className={cn(ICON_BUTTON, "hover:bg-red-50 hover:text-red-600")}
            onClick={onRemove}
            title={t("dxField.remove")}
            aria-label={t("dxField.remove")}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-[12px] text-red-600">
          {t(ERROR_TEXT[error])}
        </p>
      )}
    </div>
  );
}
