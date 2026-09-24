"use client";

import { useEffect, useRef, useState } from "react";
import { LockIcon, LockOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { SlugFieldProps } from "./types";
import { useExtT } from "../ext-locale";
import { slugify, slugifyDraft } from "../slug";

// slug field: auto-slugifies from the slugField source value (wired by
// FormView via the `sourceValue` prop) until the user edits the slug input
// manually — then it locks and stops following the source. Lock/unlock is
// also a manual toggle. 正規化規則與 server 同一支(../slug.ts),預覽的就是
// 存下來的(content-provider.ts 存檔時還會再正規化 + 唯一化)。

export function SlugField({
  value,
  onChange,
  field,
  error,
  disabled,
  sourceValue,
}: SlugFieldProps) {
  // Locked = auto-sync from sourceValue. Unlocks the moment the user types
  // directly into the slug input, or can be manually re-locked/unlocked.
  // 開啟既有項目時,只有 slug 本來就是「由標題算出來的那個」(或還是空的)才上鎖;
  // 否則一打開表單就會用標題把手打過的 slug 蓋掉,存檔後網址跟著變。
  const [locked, setLocked] = useState(
    () => !value || value === slugify(sourceValue ?? ""),
  );
  const lastAutoValue = useRef<string>("");
  // 輸入法組字中不正規化:拼音 / 注音的草稿字一被改寫,組字就斷了。
  const composing = useRef(false);
  const t = useExtT();

  useEffect(() => {
    if (!locked || sourceValue === undefined) return;
    const next = slugify(sourceValue);
    if (next === lastAutoValue.current && next === value) return;
    lastAutoValue.current = next;
    onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, sourceValue]);

  return (
    <div className="flex items-stretch gap-1.5">
      <Input
        id={`field-${field.key}`}
        value={value ?? ""}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        className="flex-1"
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          onChange(slugifyDraft(e.currentTarget.value));
        }}
        onChange={(e) => {
          if (locked) setLocked(false);
          const raw = e.target.value;
          // 逐字時保留結尾的 `-`,才打得出第二個詞;離開輸入框再收尾(onBlur)。
          onChange(composing.current ? raw : slugifyDraft(raw));
        }}
        onBlur={(e) => {
          const done = slugify(e.currentTarget.value);
          if (done !== e.currentTarget.value) onChange(done);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        disabled={disabled}
        aria-pressed={locked}
        aria-label={t(locked ? "dxField.slug.unlock" : "dxField.slug.lock")}
        title={t(locked ? "dxField.slug.syncing" : "dxField.slug.manual")}
        className={cn(
          "h-9 w-9 shrink-0 rounded-3xl transition-[background-color,color] active:scale-[0.96]",
          locked && "text-primary",
        )}
        onClick={() => setLocked((prev) => !prev)}
      >
        {locked ? <LockIcon className="size-4" /> : <LockOpenIcon className="size-4" />}
      </Button>
    </div>
  );
}
