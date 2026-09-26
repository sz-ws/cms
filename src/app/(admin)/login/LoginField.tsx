"use client";

import { cn } from "@/lib/utils";

// 登入表單與忘記密碼共用的欄位與主按鈕(1.56.0 從 LoginForm 抽出來)。

export function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  placeholder,
  hint,
  inputMode,
  maxLength,
  minLength,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  placeholder?: string;
  /** 欄位下方的一行說明(例如密碼長度)。 */
  hint?: string;
  inputMode?: "numeric" | "email" | "text";
  maxLength?: number;
  minLength?: number;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-black/55">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        autoComplete={autoComplete}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        minLength={minLength}
        aria-describedby={hintId}
        className="h-10 w-full rounded-[8px] border border-black/10 bg-white px-3 text-[14px] text-black/85 transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-black/25 focus:border-black/30 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.05)]"
      />
      {hint && (
        <p id={hintId} className="text-[12px] text-black/40">
          {hint}
        </p>
      )}
    </div>
  );
}

export function PrimaryButton({
  pending,
  label,
  pendingLabel,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        "mt-1 flex h-10 items-center justify-center gap-1.5 rounded-[8px] bg-black pr-3 pl-3.5 text-[14px] font-medium text-white",
        "transition-[background-color,transform] duration-150 ease-out",
        "hover:bg-black/85 active:scale-[0.96]",
        "focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.15)] focus-visible:outline-none",
        pending && "cursor-wait opacity-60",
      )}
    >
      <span>{pending ? pendingLabel : label}</span>
      {!pending && (
        <span aria-hidden className="text-white/70">
          →
        </span>
      )}
    </button>
  );
}

/** 表單下方的文字連結(忘記密碼、回到登入、重寄)。 */
export function TextButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-fit text-[13px] text-black/45 underline decoration-black/15 underline-offset-2 transition-colors hover:text-black/70 hover:decoration-black/35 disabled:cursor-default disabled:no-underline disabled:hover:text-black/45"
    >
      {children}
    </button>
  );
}
