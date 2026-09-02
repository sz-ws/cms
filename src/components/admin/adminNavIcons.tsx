import {
  Clock,
  FileText,
  Image as ImageIcon,
  Images,
  LayoutDashboard,
  LayoutTemplate,
  Mail,
  MessageCircle,
  Package,
  Puzzle,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { AdminNavItem } from "./AdminSidebar";

// Real SVG line icons per nav item (matching the mock's Lucide-style set).
// Default behavior is still heuristic by kind + route/title, but declarative/code
// extensions may now opt into an explicit icon token via `icon` on the runtime
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

const DECLARED_ICONS: Record<(typeof SUPPORTED_ADMIN_ICON_TOKENS)[number], LucideIcon> = {
  clock: Clock,
  dashboard: LayoutDashboard,
  image: ImageIcon,
  images: Images,
  file: FileText,
  "file-text": FileText,
  layout: LayoutTemplate,
  "layout-template": LayoutTemplate,
  mail: Mail,
  message: MessageCircle,
  "message-circle": MessageCircle,
  package: Package,
  puzzle: Puzzle,
  settings: SlidersHorizontal,
  "settings-2": Settings2,
  sliders: SlidersHorizontal,
  store: Store,
  users: Users,
};

function iconFromToken(token: string | undefined): LucideIcon | null {
  if (!token) return null;
  return DECLARED_ICONS[token.toLowerCase() as keyof typeof DECLARED_ICONS] ?? null;
}

export function adminIconManifestHelpText(): string {
  return `Top-level declarative manifest field \`icon\` controls the admin sidebar/menu icon. Supported tokens: ${SUPPORTED_ADMIN_ICON_TOKENS.join(", ")}. Example: { \"icon\": \"mail\" }.`;
}

// Core admin routes are a fixed, known set → exact href match.
const CORE_ICONS: Record<string, LucideIcon> = {
  "/admin": LayoutDashboard,
  // AI 助理(docs/spec-admin-agent.md §5)。走 CORE_ICONS 而不是 manifest token:
  // 它是 core 的固定路由,不需要讓 extension 有辦法宣告成這個圖示。
  "/admin/agent": Sparkles,
  "/admin/media": ImageIcon,
  "/admin/settings": SlidersHorizontal,
  "/admin/users": Users,
};

// Shop routes (the reframed extensions manager).
const SHOP_ICONS: Record<string, LucideIcon> = {
  "/admin/extensions?tab=browse": Store,
  "/admin/extensions": Package,
};

/**
 * Guess a Content-group icon for an extension page without a declared `icon`.
 * Keyword-match on the href (which carries the extension id: /admin/ext/gallery)
 * *and* the title. Matching the title alone broke the moment titles were
 * localized — 「相片集」 contains no "galler", so every zh-Hant site got the
 * puzzle-piece fallback, which in a sidebar always reads as a placeholder.
 */
function contentIconFor(href: string, title: string): LucideIcon {
  const t = `${href} ${title}`.toLowerCase();
  if (/(galler|photo|image|media|相片|圖片|相簿)/.test(t)) return Images;
  if (/(blog|post|article|news|writ|文章|部落格)/.test(t)) return FileText;
  if (/(page|showcase|structural|layout|頁面)/.test(t)) return LayoutTemplate;
  if (/(contact|message|inbox|mail|聯絡|訊息)/.test(t)) return Mail;
  if (/(cron|schedule|排程)/.test(t)) return Clock;
  return Puzzle;
}

/** Resolve the icon for a nav item based on explicit token first, then fallback heuristics. */
export function iconForNavItem(item: AdminNavItem): LucideIcon {
  const declared = iconFromToken(item.icon);
  if (declared) return declared;
  if (item.kind === "shop") return SHOP_ICONS[item.href] ?? Package;
  if (item.kind === "extension") return contentIconFor(item.href, item.title);
  return CORE_ICONS[item.href] ?? LayoutDashboard;
}
