import { createElement, type ComponentType, type SVGProps } from "react";
import {
  AdjustmentsHorizontalIcon,
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  BanknotesIcon,
  BugAntIcon,
  BuildingLibraryIcon,
  BuildingStorefrontIcon,
  ChartBarIcon,
  ChatBubbleLeftIcon,
  ClipboardDocumentListIcon,
  ClockIcon,
  Cog6ToothIcon,
  CreditCardIcon,
  CubeIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  FolderIcon,
  GiftIcon,
  MegaphoneIcon,
  PhotoIcon,
  PuzzlePieceIcon,
  ReceiptPercentIcon,
  ShoppingBagIcon,
  ShoppingCartIcon,
  SparklesIcon,
  Squares2X2Icon,
  TagIcon,
  TruckIcon,
  UsersIcon,
  WalletIcon,
  WindowIcon,
} from "@heroicons/react/16/solid";
import {
  Archive,
  Banknote,
  BarChart3,
  Blocks,
  Bug,
  ClipboardList,
  Clock,
  CreditCard,
  FileText,
  FolderTree,
  Gift,
  HandCoins,
  HardDrive,
  Image as ImageIcon,
  Landmark,
  LayoutDashboard,
  Mail,
  Megaphone,
  MessageCircle,
  Package,
  PanelsTopLeft,
  Puzzle,
  Settings,
  Settings2,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Store,
  Ticket,
  Truck,
  Undo2,
  Users,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isInlineSvgIcon } from "@/ext/admin-icon";
import type { AdminIconSet } from "@/lib/admin-theme";
import { useAdminIconSet } from "./admin-icon-set";
import type { AdminNavItem } from "./AdminSidebar";

/** Any icon component that renders an <svg> and takes a className. */
export type AdminIcon = ComponentType<SVGProps<SVGSVGElement>>;

// Sidebar icons come in two sets, picked by the admin style (core.adminTheme.icons):
//
// - solid (default): Heroicons **16px solid** (the "micro" set — drawn for exactly
//   this size, not scaled down from 24). Filled glyphs were chosen over Lucide's
//   outlines on purpose: at 13px label size a 1.5–2px stroke icon is the look of
//   every Tailwind admin template, and the same seven outline glyphs appear in all
//   of them. Solid shapes carry weight the way SF Symbols do in macOS sidebars,
//   which is the register this admin is after (admin-design-language.md).
// - outline: Lucide, for sites that want that look. The glyphs follow the usual
//   Lucide admin picks (dashboard LayoutDashboard, orders ShoppingBag, coupons
//   Ticket, payouts HandCoins, files HardDrive, settings Settings2 …).
//
// Lucide remains the icon library everywhere *else* in the admin (Suko's
// standing decision, 2026-07-11). Every icon has a library-neutral name below, so
// a manifest's `icon: "mail"` keeps meaning "an envelope" whichever set renders it.
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
  // 1.38.0:商務與營運類 extension 用的 token(wallet / inventory / fulfillment /
  // shop / 金流 / 錯誤追蹤 …)。名稱維持 library-neutral。
  "archive",
  "banknotes",
  "bug",
  "chart",
  "clipboard",
  "credit-card",
  // 1.48.0:分類(商品分類這類階層清單)。
  "folder",
  "gift",
  "landmark",
  "megaphone",
  "receipt",
  // 1.50.0:退貨(往回的箭頭)。
  "return",
  "shopping-bag",
  "shopping-cart",
  "tag",
  "truck",
  "wallet",
] as const;

type Token = (typeof SUPPORTED_ADMIN_ICON_TOKENS)[number];

/** 兩套圖示共用的名稱:manifest token(去掉同義詞)加上 core 路由與推測用的幾個。 */
type Glyph =
  | Exclude<Token, "images" | "file-text" | "layout-template" | "message-circle" | "sliders">
  | "sparkles"
  | "media"
  | "extensions";

const SYNONYMS: Partial<Record<Token, Glyph>> = {
  images: "image",
  "file-text": "file",
  "layout-template": "layout",
  "message-circle": "message",
  sliders: "settings",
};

const SOLID: Record<Glyph, AdminIcon> = {
  clock: ClockIcon,
  dashboard: Squares2X2Icon,
  image: PhotoIcon,
  file: DocumentTextIcon,
  layout: WindowIcon,
  mail: EnvelopeIcon,
  message: ChatBubbleLeftIcon,
  package: CubeIcon,
  puzzle: PuzzlePieceIcon,
  settings: AdjustmentsHorizontalIcon,
  "settings-2": Cog6ToothIcon,
  store: BuildingStorefrontIcon,
  users: UsersIcon,
  archive: ArchiveBoxIcon,
  banknotes: BanknotesIcon,
  bug: BugAntIcon,
  chart: ChartBarIcon,
  clipboard: ClipboardDocumentListIcon,
  "credit-card": CreditCardIcon,
  folder: FolderIcon,
  gift: GiftIcon,
  landmark: BuildingLibraryIcon,
  megaphone: MegaphoneIcon,
  receipt: ReceiptPercentIcon,
  return: ArrowUturnLeftIcon,
  "shopping-bag": ShoppingBagIcon,
  "shopping-cart": ShoppingCartIcon,
  tag: TagIcon,
  truck: TruckIcon,
  wallet: WalletIcon,
  sparkles: SparklesIcon,
  media: FolderIcon,
  extensions: CubeIcon,
};

const OUTLINE: Record<Glyph, AdminIcon> = {
  clock: Clock,
  dashboard: LayoutDashboard,
  image: ImageIcon,
  file: FileText,
  layout: PanelsTopLeft,
  mail: Mail,
  message: MessageCircle,
  package: Package,
  puzzle: Puzzle,
  settings: Settings2,
  "settings-2": Settings,
  store: Store,
  users: Users,
  archive: Archive,
  banknotes: Banknote,
  bug: Bug,
  chart: BarChart3,
  clipboard: ClipboardList,
  "credit-card": CreditCard,
  folder: FolderTree,
  gift: Gift,
  landmark: Landmark,
  megaphone: Megaphone,
  receipt: HandCoins,
  return: Undo2,
  "shopping-bag": ShoppingBag,
  "shopping-cart": ShoppingCart,
  tag: Ticket,
  truck: Truck,
  wallet: Wallet,
  sparkles: Sparkles,
  media: HardDrive,
  extensions: Blocks,
};

const ICON_SETS: Record<AdminIconSet, Record<Glyph, AdminIcon>> = { solid: SOLID, outline: OUTLINE };

function glyphFromToken(token: string | undefined): Glyph | null {
  if (!token) return null;
  const key = token.toLowerCase();
  if (!(SUPPORTED_ADMIN_ICON_TOKENS as readonly string[]).includes(key)) return null;
  return SYNONYMS[key as Token] ?? (key as Glyph);
}

export function adminIconManifestHelpText(): string {
  return `Top-level declarative manifest field \`icon\` controls the admin sidebar/menu icon. Supported tokens: ${SUPPORTED_ADMIN_ICON_TOKENS.join(", ")}. Example: { \"icon\": \"mail\" }.`;
}

// Core admin routes are a fixed, known set → exact href match.
const CORE_GLYPHS: Record<string, Glyph> = {
  "/admin": "dashboard",
  // AI 助理(docs/spec-admin-agent.md §5)。走 core 路由而不是 manifest token:
  // 它是 core 的固定路由,不需要讓 extension 有辦法宣告成這個圖示。
  "/admin/agent": "sparkles",
  "/admin/media": "media",
  "/admin/settings": "settings",
  "/admin/users": "users",
};

// Shop routes (the reframed extensions manager).
const SHOP_GLYPHS: Record<string, Glyph> = {
  "/admin/extensions?tab=browse": "store",
  "/admin/extensions": "extensions",
};

/**
 * Guess a Content-group icon for an extension page without a declared `icon`.
 * Keyword-match on the href (which carries the extension id: /admin/ext/gallery)
 * *and* the title. Matching the title alone broke the moment titles were
 * localized — 「相片集」 contains no "galler", so every zh-Hant site got the
 * puzzle-piece fallback, which in a sidebar always reads as a placeholder.
 */
function contentGlyphFor(href: string, title: string): Glyph {
  const t = `${href} ${title}`.toLowerCase();
  if (/(galler|photo|image|media|相片|圖片|相簿)/.test(t)) return "image";
  if (/(blog|post|article|news|writ|文章|部落格)/.test(t)) return "file";
  if (/(page|showcase|structural|layout|頁面)/.test(t)) return "layout";
  if (/(contact|message|inbox|mail|聯絡|訊息)/.test(t)) return "mail";
  if (/(cron|schedule|排程)/.test(t)) return "clock";
  return "puzzle";
}

type NavIconItem = Pick<AdminNavItem, "href" | "title" | "kind" | "icon">;

function glyphForNavItem(item: NavIconItem): Glyph {
  const declared = glyphFromToken(item.icon);
  if (declared) return declared;
  if (item.kind === "shop") return SHOP_GLYPHS[item.href] ?? "extensions";
  if (item.kind === "extension") return contentGlyphFor(item.href, item.title);
  return CORE_GLYPHS[item.href] ?? "dashboard";
}

/**
 * Render a nav item's icon. 1.39.0: `icon` may be an inline `<svg>` (validated by
 * svg-guard in the manifest schema and again in AdminShell before it reaches the
 * client), rendered as-is so an extension can ship its own mark. The svg's own
 * colour is forced to `currentColor` — Intent's sidebar sets `color` directly on
 * any `svg` without a text-* class, which would otherwise pin a custom icon to
 * muted-fg and ignore the active/idle colour set on the wrapper.
 */
export function NavIcon({ item, className }: { item: NavIconItem; className?: string }) {
  const set = useAdminIconSet();
  if (item.icon && isInlineSvgIcon(item.icon)) {
    return (
      <span
        aria-hidden
        data-slot="nav-icon"
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center [&>svg]:size-4 [&>svg]:text-current!",
          className,
        )}
        dangerouslySetInnerHTML={{ __html: item.icon }}
      />
    );
  }
  // createElement, not <Icon/>: the component is one of the static icons above,
  // looked up per item — nothing is created during render.
  return createElement(iconForNavItem(item, set), { "aria-hidden": true, className });
}

/** 用圖示代號畫一個側欄圖示(風格預覽的迷你側欄用),跟著目前的圖示組。 */
export function AdminTokenIcon({ token, className }: { token: Token; className?: string }) {
  const set = useAdminIconSet();
  return createElement(ICON_SETS[set][glyphFromToken(token) ?? "dashboard"], { "aria-hidden": true, className });
}

/** Resolve the icon for a nav item based on explicit token first, then fallback heuristics. */
export function iconForNavItem(item: NavIconItem, set: AdminIconSet = "solid"): AdminIcon {
  return ICON_SETS[set][glyphForNavItem(item)];
}
