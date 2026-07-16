"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { JSONContent } from "@tiptap/core";
import {
  registerExtensionLayout,
  type LayoutComponentProps,
} from "@/ext/dx/extension-layouts";

// `extensions/blog/layout.tsx` — Notion-style editor, Paper & Ink visual
// language. Cover hero at top (with generate presets), then a concentric-card
// editor (login-page recipe) holding title, properties, excerpt, and a real
// Tiptap richtext body.

const RichtextEditor = dynamic(() => import("@/ext/dx/fields/RichtextEditor"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-52 items-center justify-center rounded-[10px] bg-white text-[13px] text-black/45 shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
      Loading editor…
    </div>
  ),
});

const COVER_PRESETS = [
  "linear-gradient(135deg, oklch(0.92 0.05 250), oklch(0.88 0.08 290))",
  "linear-gradient(135deg, oklch(0.90 0.06 160), oklch(0.85 0.10 200))",
  "linear-gradient(135deg, oklch(0.91 0.05 30), oklch(0.86 0.08 60))",
  "linear-gradient(135deg, oklch(0.90 0.07 330), oklch(0.85 0.06 10))",
  "linear-gradient(135deg, oklch(0.92 0.04 200), oklch(0.88 0.06 240))",
  "linear-gradient(135deg, oklch(0.89 0.08 140), oklch(0.84 0.10 180))",
];

const HALO =
  "shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)]";
const CARD =
  "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]";

type Strings = Record<string, string>;

const STRING_FIELDS = ["title", "slug", "excerpt", "cover", "author", "publishedAt"] as const;

function seedStrings(props: LayoutComponentProps): Strings {
  const initial = (props.initialData ?? {}) as Record<string, unknown>;
  const out: Strings = {};
  for (const key of STRING_FIELDS) out[key] = readStr(initial, key);
  return out;
}

function readStr(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v) && key === "publishedAt") {
    return new Date(v).toISOString().slice(0, 10);
  }
  return "";
}

function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function BlogLayout(props: LayoutComponentProps) {
  const router = useRouter();
  const [str, setStr] = useState<Strings>(() => seedStrings(props));
  const [body, setBody] = useState<unknown>(props.initialData?.body ?? "");
  const [initialBody] = useState(() => props.initialData?.body ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [ogPreviewOpen, setOgPreviewOpen] = useState(false);
  const [showBar, setShowBar] = useState(false);
  const [coverPreset, setCoverPreset] = useState(0);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);

  const baseline = useMemo(() => seedStrings(props), [props]);
  const dirty = useMemo(() => {
    if (STRING_FIELDS.some((k) => str[k] !== baseline[k])) return true;
    return JSON.stringify(body) !== JSON.stringify(initialBody);
  }, [str, baseline, body, initialBody]);
  const isEdit = Boolean(props.initialId);

  useEffect(() => autoGrow(titleRef.current), [titleRef]);

  useEffect(() => {
    if (dirty || pending || saved) {
      setShowBar(true);
      return;
    }
    const t = window.setTimeout(() => setShowBar(false), 220);
    return () => window.clearTimeout(t);
  }, [dirty, pending, saved]);

  function update(key: (typeof STRING_FIELDS)[number], value: string) {
    setStr((p) => ({ ...p, [key]: value }));
    if (error) setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    const url = isEdit
      ? `/api/ext/${props.extId}/${props.typeName}/${encodeURIComponent(props.initialId!)}`
      : `/api/ext/${props.extId}/${props.typeName}`;
    const payload: Record<string, unknown> = { ...str, body, status: "draft" };
    if (str.publishedAt) {
      const t = Date.parse(str.publishedAt);
      if (Number.isFinite(t)) payload.publishedAt = t;
    }
    try {
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError(`Save failed (${res.status})`);
        return;
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1200);
      router.push(props.backHref);
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setPending(false);
    }
  }

  const coverKey = str.cover.trim();
  const hasCover = coverKey.length > 0;

  return (
    <form onSubmit={onSubmit} className={`relative flex flex-col gap-5 ${showBar ? "pb-28" : "pb-6"}`}>
      {/* ── Cover hero (padded, not full-bleed) ── */}
      <div className="relative -mx-4 -mt-4 lg:-mx-6 lg:-mt-6">
        <div className="relative h-[240px] w-full px-4 pt-4 pb-12 sm:h-[320px] lg:px-6 lg:pt-6">
          <div className="relative size-full overflow-hidden rounded-[14px] shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)]">
            {hasCover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/files/${coverKey}`}
                alt=""
                className="size-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.opacity = "0.2";
                }}
              />
            ) : (
              <div
                className="size-full transition-[background-image] duration-300"
                style={{ backgroundImage: COVER_PRESETS[coverPreset] }}
              />
            )}
          </div>
        </div>
        {/* cover controls — Paper & Ink pill buttons */}
        <div className="absolute inset-x-0 bottom-6 flex justify-center gap-2">
          <CoverButton onClick={() => setPickerOpen(true)}>
            {hasCover ? "Change cover" : "Add cover"}
          </CoverButton>
          {!hasCover && (
            <CoverButton
              onClick={() => {
                if (isEdit && str.slug) {
                  setOgPreviewOpen(true);
                } else {
                  alert("Please save this post and set a slug first to generate its OG image.");
                }
              }}
            >
              ↻ Generate from OG
            </CoverButton>
          )}
        </div>
      </div>

      {/* ── Editor card — concentric halo (login recipe) ── */}
      <div className={`mt-2 rounded-[20px] bg-white/55 p-1.5 backdrop-blur-md ${HALO}`}>
        <div className={`rounded-[14px] bg-white px-6 pt-6 pb-5 ${CARD}`}>
          {/* title */}
          <textarea
            ref={titleRef}
            value={str.title}
            onChange={(e) => {
              update("title", e.target.value);
              autoGrow(e.target);
            }}
            placeholder="Untitled"
            rows={1}
            className="w-full resize-none bg-transparent text-[28px] font-bold leading-tight tracking-[-0.01em] text-black/90 outline-none placeholder:text-black/25 sm:text-[32px]"
          />

          {/* properties */}
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2.5 border-t border-black/[0.06] pt-4">
            <PropRow label="Author">
              <PropInput
                value={str.author}
                onChange={(v) => update("author", v)}
                placeholder="Jane Doe"
              />
            </PropRow>
            <PropRow label="Published">
              <input
                type="date"
                value={str.publishedAt}
                onChange={(e) => update("publishedAt", e.target.value)}
                className="bg-transparent text-[13px] text-black/85 outline-none focus:bg-black/[0.03] focus:rounded-[4px] focus:px-1 focus:py-0.5"
              />
            </PropRow>
            <PropRow label="Slug">
              <PropInput
                value={str.slug}
                onChange={(v) => update("slug", v)}
                placeholder="my-post"
                mono
              />
            </PropRow>
          </div>

          {/* excerpt */}
          <div className="mt-5">
            <Label>Excerpt</Label>
            <textarea
              value={str.excerpt}
              onChange={(e) => update("excerpt", e.target.value)}
              placeholder="A short hook for listings…"
              rows={2}
              className="mt-1.5 min-h-[56px] w-full resize-none rounded-[8px] border border-black/10 bg-white px-3 py-2 text-[14px] leading-relaxed text-black/65 outline-none transition-[border-color,box-shadow] duration-150 focus:border-black/30 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.05)] placeholder:text-black/25"
            />
          </div>

          {/* body — real Tiptap richtext */}
          <div className="mt-5">
            <Label>Body</Label>
            <div className="mt-1.5">
              <RichtextEditor
                value={body}
                onChange={(doc: JSONContent) => setBody(doc)}
                disabled={false}
                invalid={false}
                fieldKey="body"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Save bar ── */}
      <div
        className={[
          "pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 transition-[opacity,transform] duration-220 ease-out",
          showBar ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0",
        ].join(" ")}
      >
        <div className={`pointer-events-auto w-full max-w-3xl rounded-[20px] bg-white/65 p-1.5 backdrop-blur-md ${HALO}`}>
          <div className={`flex items-center justify-between gap-4 rounded-[14px] bg-white px-4 py-3 ${CARD}`}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[12px] font-medium text-black/45">
                {pending ? "Saving…" : saved ? "Saved" : dirty ? "Ready to save" : "Up to date"}
              </span>
              <span className="text-[11px] text-black/35">
                {error ?? (saved ? "Saved." : dirty ? "Unsaved changes." : "Notion-style editor")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setStr(baseline);
                  setBody(initialBody);
                  router.push(props.backHref);
                }}
                disabled={!dirty}
                className="inline-flex h-9 items-center rounded-[8px] px-3 text-[13px] font-medium text-black/55 transition-colors hover:bg-black/[0.03] hover:text-black/85 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Discard
              </button>
              <button
                type="submit"
                disabled={pending || !dirty}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[8px] bg-black pr-3 pl-3.5 text-[14px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-black/85 active:scale-[0.96] focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.15)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span>{pending ? "Saving…" : isEdit ? "Save" : "Publish"}</span>
                {!pending && <span aria-hidden className="text-white/70">→</span>}
              </button>
            </div>
          </div>
        </div>
      </div>

      {pickerOpen && (
        <MediaCoverPicker
          current={coverKey}
          onPick={(key) => {
            update("cover", key);
            setPickerOpen(false);
          }}
          onClear={() => {
            update("cover", "");
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {ogPreviewOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
          onClick={() => setOgPreviewOpen(false)}
        >
          <div
            className={`flex w-full max-w-4xl flex-col gap-4 overflow-hidden rounded-[20px] bg-white p-5 ${HALO}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
                OG Image Preview
              </h3>
              <button
                type="button"
                onClick={() => setOgPreviewOpen(false)}
                className="text-[12px] text-black/45 hover:text-black/85"
              >
                Close
              </button>
            </div>
            <div className="relative aspect-[1200/630] w-full overflow-hidden rounded-[10px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] bg-black/5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/og/${props.extId}/${props.typeName}/${encodeURIComponent(str.slug)}`}
                alt="OG Preview"
                className="size-full object-contain"
              />
            </div>
            <p className="text-[12px] text-black/45 text-center">
              This is generated from the OGImageCN Blog template using your post data.
            </p>
          </div>
        </div>
      )}
    </form>
  );
}

function CoverButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/85 px-3 text-[12px] font-medium text-black/70 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_6px_-2px_rgba(0,0,0,0.15)] backdrop-blur-sm transition-colors hover:bg-white"
    >
      {children}
    </button>
  );
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-black/40">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function PropInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`bg-transparent text-[13px] text-black/85 outline-none placeholder:text-black/25 focus:bg-black/[0.03] focus:rounded-[4px] focus:px-1.5 focus:py-0.5 ${mono ? "font-mono" : ""}`}
    />
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[13px] font-medium text-black/55">{children}</span>
  );
}

function MediaCoverPicker({
  current,
  onPick,
  onClear,
  onClose,
}: {
  current: string;
  onPick: (key: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<{ key: string; contentType: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/media/list")
      .then((r) => r.json())
      .then((data: unknown) => {
        if (!active) return;
        const payload = data as { files?: { key?: unknown }[] };
        const list = Array.isArray(payload?.files) ? payload.files : [];
        setFiles(
          list.filter((f) => typeof f.key === "string") as {
            key: string;
            contentType: string;
          }[],
        );
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const images = files.filter((f) => /\.(png|jpe?g|gif|webp|avif)$/i.test(f.key));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`flex max-h-[70vh] w-full max-w-2xl flex-col gap-4 overflow-hidden rounded-[20px] bg-white p-5 ${HALO}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
            Cover image
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-black/45 hover:text-black/85"
          >
            Close
          </button>
        </div>
        {loading ? (
          <p className="py-10 text-center text-[13px] text-black/45">Loading…</p>
        ) : images.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-black/45">
            No images yet. Upload one in Media first.
          </p>
        ) : (
          <ul className="grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
            {images.map((f) => (
              <li key={f.key}>
                <button
                  type="button"
                  onClick={() => onPick(f.key)}
                  className={`relative aspect-[16/9] w-full overflow-hidden rounded-[8px] transition-shadow hover:shadow-[0_0_0_2px_rgb(86,114,228)] ${
                    current === f.key
                      ? "shadow-[0_0_0_2px_rgb(86,114,228)]"
                      : "shadow-[0_0_0_1px_rgba(0,0,0,0.06)]"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/files/${f.key}`}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
        {current && (
          <button
            type="button"
            onClick={onClear}
            className="self-start text-[12px] text-black/45 underline-offset-2 hover:text-black/85 hover:underline"
          >
            Remove cover
          </button>
        )}
      </div>
    </div>
  );
}

registerExtensionLayout("blog", BlogLayout);
