import type { ComponentType, SVGProps } from "react";
import {
  AdjustmentsHorizontalIcon,
  BuildingStorefrontIcon,
  ChatBubbleLeftIcon,
  ClockIcon,
  Cog6ToothIcon,
  CubeIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  FolderIcon,
  PhotoIcon,
  PuzzlePieceIcon,
  SparklesIcon,
  Squares2X2Icon,
  UsersIcon,
  WindowIcon,
} from "@heroicons/react/16/solid";
import type { AdminNavItem } from "./AdminSidebar";

/** Any icon component that renders an <svg> and takes a className. */
export type AdminIcon = ComponentType<SVGProps<SVGSVGElement>>;

// Sidebar icons: Heroicons **16px solid** (the "micro" set — drawn for exactly
// this size, not scaled down from 24). Filled glyphs were chosen over Lucide's
// outlines on purpose: at 13px label size a 1.5–2px stroke icon is the look of
// every Tailwind admin template, and the same seven outline glyphs appear in all
// of them. Solid shapes carry weight the way SF Symbols do in macOS sidebars,
// which is the register this admin is after (admin-design-language.md).
//
// Lucide remains the icon library everywhere *else* in the admin (Suko's
// standing decision, 2026-07-11); this file is the one deliberate exception and
// the token names below stay library-neutral so a manifest's `icon: "mail"`
// keeps meaning "an envelope" whichever set renders it.
//
// Default behavior is still heuristic by kind + route/title, but declarative/code
// extensions may opt into an explicit icon token via `icon` on the runtime
// Extension manifest.

export const SUPPORTED_ADMIN_ICON_TOKENS = [
  "clock",
  "dashboard",
  "image",
  "images",
  "file",
  "file-text",
  "layout",
  "layout-template",
  "mail",
  "message",
  "message-circle",
  "package",
  "puzzle",
  "settings",
  "settings-2",
  "sliders",
  "store",
  "users",
] as const;

const DECLARED_ICONS: Record<(typeof SUPPORTED_ADMIN_ICON_TOKENS)[number], AdminIcon> = {
  clock: ClockIcon,
  dashboard: Squares2X2Icon,
  image: PhotoIcon,
  images: PhotoIcon,
  file: DocumentTextIcon,
  "file-text": DocumentTextIcon,
  layout: WindowIcon,
  "layout-template": WindowIcon,
  mail: EnvelopeIcon,
  message: ChatBubbleLeftIcon,
  "message-circle": ChatBubbleLeftIcon,
  package: CubeIcon,
  puzzle: PuzzlePieceIcon,
  settings: AdjustmentsHorizontalIcon,
  "settings-2": Cog6ToothIcon,
  sliders: AdjustmentsHorizontalIcon,
  store: BuildingStorefrontIcon,
  users: UsersIcon,
};

function iconFromToken(token: string | undefined): AdminIcon | null {
  if (!token) return null;
  return DECLARED_ICONS[token.toLowerCase() as keyof typeof DECLARED_ICONS] ?? null;
}

export function adminIconManifestHelpText(): string {
  return `Top-level declarative manifest field \`icon\` controls the admin sidebar/menu icon. Supported tokens: ${SUPPORTED_ADMIN_ICON_TOKENS.join(", ")}. Example: { \"icon\": \"mail\" }.`;
}

// Core admin routes are a fixed, known set → exact href match.
const CORE_ICONS: Record<string, AdminIcon> = {
  "/admin": Squares2X2Icon,
  // AI 助理(docs/spec-admin-agent.md §5)。走 CORE_ICONS 而不是 manifest token:
  // 它是 core 的固定路由,不需要讓 extension 有辦法宣告成這個圖示。
  "/admin/agent": SparklesIcon,
  "/admin/media": FolderIcon,
  "/admin/settings": AdjustmentsHorizontalIcon,
  "/admin/users": UsersIcon,
};

// Shop routes (the reframed extensions manager).
const SHOP_ICONS: Record<string, AdminIcon> = {
  "/admin/extensions?tab=browse": BuildingStorefrontIcon,
  "/admin/extensions": CubeIcon,
};

/**
 * Guess a Content-group icon for an extension page without a declared `icon`.
 * Keyword-match on the href (which carries the extension id: /admin/ext/gallery)
 * *and* the title. Matching the title alone broke the moment titles were
 * localized — 「相片集」 contains no "galler", so every zh-Hant site got the
 * puzzle-piece fallback, which in a sidebar always reads as a placeholder.
 */
function contentIconFor(href: string, title: string): AdminIcon {
  const t = `${href} ${title}`.toLowerCase();
  if (/(galler|photo|image|media|相片|圖片|相簿)/.test(t)) return PhotoIcon;
  if (/(blog|post|article|news|writ|文章|部落格)/.test(t)) return DocumentTextIcon;
  if (/(page|showcase|structural|layout|頁面)/.test(t)) return WindowIcon;
  if (/(contact|message|inbox|mail|聯絡|訊息)/.test(t)) return EnvelopeIcon;
  if (/(cron|schedule|排程)/.test(t)) return ClockIcon;
  return PuzzlePieceIcon;
}

/** Resolve the icon for a nav item based on explicit token first, then fallback heuristics. */
export function iconForNavItem(item: AdminNavItem): AdminIcon {
  const declared = iconFromToken(item.icon);
  if (declared) return declared;
  if (item.kind === "shop") return SHOP_ICONS[item.href] ?? CubeIcon;
  if (item.kind === "extension") return contentIconFor(item.href, item.title);
  return CORE_ICONS[item.href] ?? Squares2X2Icon;
}
