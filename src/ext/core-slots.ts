import type { AdminMenuItem, AdminNavSection } from "./admin-menu";
import type { CollectionViewProps } from "./dx/views/CollectionView";
import type { FormViewPageProps } from "./dx/views/FormViewPage";
import type { PublicFrameProps, PublicMetadataStep, PublicViewportStep } from "./public-pages";
import type { ResolvedStatusSets } from "./record-status";
import { defineSlot, defineValueSlot, type ViewSlot } from "./slots";

// 本體自己宣告的插槽(機制見 slots.ts)。插件宣告的插槽放在插件自己的資料夾裡。
// 另外三個本體的插槽連同它們的讀法各放一個檔:account-entries.ts 的 AccountEntries(「我的帳戶」裡各插件的項目)、
// after-sign-in.ts 的 AfterSignIn(登入後插件要會員先走的一步,1.76.0)、
// admin-attention.ts 的 AdminAttention(後台哪一頁現在有事在等人處理,側欄在那一頁旁邊畫一個點,1.77.0)。

/**
 * 後台側欄的分區(預設五區:workspace、content、commerce、shop、system)。填的人可以改名、加區、
 * 排序、決定收合方式;項目再用 AdminSidebarItems 的 `section` 指過去。輸出經 normalizeAdminSections
 * 收斂(ext/admin-menu.ts)。
 */
export const AdminSidebarSections = defineValueSlot<AdminNavSection[]>("admin.sidebar.sections");

/** 後台側欄的項目:固定項加上每個啟用中插件的後台頁。填的人可以增刪、改名、換分區、排序。 */
export const AdminSidebarItems = defineValueSlot<AdminMenuItem[]>("admin.sidebar.items");

/**
 * 後台的狀態組(`<extId>:<setId>` → 狀態 → 名稱、色調、說明)。填的人可以改名(label)或補說明
 * (addon);系統狀態本身不變,只影響後台怎麼講。輸出經 normalizeStatusSets 收斂(ext/record-status.ts)。
 */
export const AdminStatusSets = defineValueSlot<ResolvedStatusSets>("admin.status-sets");

/**
 * sitemap 另外要列的公開網址(1.75.0)。內容型別的頁面與它們的列表頁、首頁,核心自己會列;站台或插件自己寫的頁面
 * (核心不知道它們存在)從這裡報。一項是一個站內路徑,或回傳幾個路徑的函式(那一頁在不在要查設定才知道時用;
 * 函式丟錯就當作它沒有報)。只收站內路徑,重複的只列一次(ext/dx/seo-cache.ts)。
 */
export type SitemapSource = string | (() => readonly string[] | Promise<readonly string[]>);
export const SitemapPaths = defineValueSlot<SitemapSource[]>("seo.sitemap.paths");

/**
 * 後台優惠碼表單(commerce-kit 的 PromosAdmin)裡,核心欄位之後、「啟用」之前的位置(1.76.0)。預設什麼都沒有;別的插件在這裡
 * 多放一格跟這個優惠碼有關的欄位(例如把代碼指定給某個人)。
 *
 * 這個位置在 client 元件裡:畫優惠碼頁的那一方(伺服器元件)先 `await slotParts(AdminPromoFormFields, {})`,當作
 * PromosAdmin 的 formFields 傳進去。填的元件是 client 元件,用 commerce-kit/promo-form.tsx 的 usePromoForm() 知道
 * 表單上是哪個代碼,並登記「這個代碼存好之後要一起做的事」。
 */
export const AdminPromoFormFields = defineSlot("admin.promo-form.fields");

// ---- 後台的內容頁:每個內容型別各有一個插槽 ----
// key 是完整的型別代號 `<extId>.<type>`(例如 "catalog.product")。預設內容是泛用的列表或編輯頁
// (或 overrides.ts 登記的整頁替換);別的插件在它前後加一塊(例如商品列表上方的缺貨提醒、
// 商品編輯頁下方的庫存),不必把整頁換掉。填的元件拿到的 props 跟那一頁一樣。

/** 後台某個內容型別的列表頁。 */
export function adminCollectionSlot(contentType: string): ViewSlot<CollectionViewProps> {
  return defineSlot<CollectionViewProps>(`admin.collection.${contentType}`);
}

/** 後台某個內容型別的新增／編輯頁。props.entryId:編輯中的那一筆,新增時沒有。 */
export function adminFormSlot(contentType: string): ViewSlot<FormViewPageProps> {
  return defineSlot<FormViewPageProps>(`admin.form.${contentType}`);
}

// ---- 公開頁(2.x;怎麼用見 src/ext/META.md「A site supplies its own public pages」與 ext/public-pages.ts) ----

/**
 * 每一頁的 metadata 最後流過的步驟(PublicMetadataStep)。route 自己的 metadata 先算,再照填的先後一步一步改:
 * 站台的標題後綴、分享圖、不收錄某些網址…。預設沒有步驟 = metadata 就是 route 給的(沒給就什麼都不加)。
 * 一定要 append:`fill(PublicMetadata, (steps) => [...steps, myStep])`。
 */
export const PublicMetadata = defineValueSlot<PublicMetadataStep[]>("public.metadata");

/** 每一頁的 viewport(themeColor、colorScheme…),規矩同 PublicMetadata。預設沒有步驟。 */
export const PublicViewport = defineValueSlot<PublicViewportStep[]>("public.viewport");

/**
 * 公開頁的外框,由 (public)/layout.tsx 畫:換頁時不重新掛載。props:{ notice, children }(layout 不知道網址;
 * 照網址換樣子的外框在 client 元件裡用 usePathname(),見 src/ext/META.md)。預設是公告列 + filter:publicHeader +
 * 內容 + filter:publicFooter + filter:publicWidgets。換掉(replace)的話整個外框由填的元件畫,公告放不放、放哪裡
 * 也由它決定;filter:publicWidgets 的浮層照樣由核心畫在外框後面。包起來(wrap)的拿到的 children 是預設的外框。
 */
export const PublicFrame = defineSlot<PublicFrameProps>("public.frame");

/** 404 的內容((public)/not-found.tsx,在外框裡)。預設是核心的 404:大字 404、一句話、回首頁。 */
export const PublicNotFound = defineSlot("public.not-found");
