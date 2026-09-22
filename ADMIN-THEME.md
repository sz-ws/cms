# Universal 後台風格（Admin Theme v1）

入口：`/admin/settings?tab=style`。這是 Universal CMS 的核心設定，所有管理員共用；只作用於登入後的 `/admin/**`。公開網站、登入頁及 setup 保留自己的設計。

## 儲存與相容

- `core.adminTheme`：版本化 JSON，欄位為 `version: 1`、`background`、`surface`、`ink`、`radius`（sharp/soft/round）、`elevation`（flat/line/soft）、`font`（見下方字體）、`icons`（`solid`/`outline`）。舊資料沒有後兩欄，讀進來補預設值。
- `core.adminAccent`：繼續是主色的唯一來源。舊設定/API 寫入主色仍有效。
- `/api/admin-theme`：登入使用者可 GET，只有 admin 可 PUT，mutation 必須通過 same-origin。主色與風格以同一個 `setSettings` D1 batch 儲存。
- 不需要 migration。未設定、損壞或未知版本會使用 Paper & Ink，保留合法的舊主色。
- 專用 API 與通用 `/api/settings` 都使用同一個 schema，拒絕任意 CSS、未知欄位、非法色碼、錯誤 enum 和低對比配色。V1 限淺色 surface，主要文字對比至少 7:1；主色上的字沿用原本的 `readableOn`（預設藍上是白字）。

## 套用與隔離

**Paper & Ink 就是改版前的後台。** 預設風格只輸出主色（與 `:root` 裡引用主色的 token），不寫任何主題變數、不啟用橋接，所有元件照原本的 class 與 fallback 畫。只要背景、卡片、文字、圓角、層次有一項不是預設值，`AdminTheme` 的 `<style id="cms-admin-theme">` 才帶 `data-themed`，`admin-theme.css` 的橋接與 `admin:` 變體才生效。

`AdminShell` 宣告 `data-admin-surface`。`AdminTheme` 在 SSR 時直接輸出驗證過的 CSS，範圍是 `body:has([data-admin-surface])`，所以第一次繪製就有正確風格，portalled dialogs/selects 也繼承相同變數。導向前台後 selector 自動失效。

橋接照抄 `:root` 的配方：純黑的各級透明度換成文字色，`#fbfaf9` 換成背景，白換成卡片。所以只改圓角或層次時顏色不變。層次的「柔和」就是各元件原本的陰影（變數設成 `initial`，走 fallback），「細邊線」與「平面」才換掉。

這取代舊 accent 的「以瀏覽器快取為真相」模式。localStorage `cms.adminTheme.v1` 只用來通知其他分頁更新；後台在路由改變、視窗重新取得焦點及 storage event 時重新確認伺服器值。快取被停用不妨礙儲存或套用。

編輯器的草稿只影響 `data-admin-theme-preview` 範圍：選紙與墨時是 `="default"`，在預覽區塊重套原本的 `:root` token 並清掉外層已存的主題變數；其他是 `="custom"`。Preview 使用真實 Input、Button、CoreTable 與 Dialog，對話框帶有相同草稿 token。儲存失敗保留草稿；放棄變更回到已儲存值；恢復預設仍須儲存才影響全站。

## 字體

`ADMIN_FONTS`（`lib/admin-theme.ts`）是白名單：預設的昭源黑體（Geist + 自架 Chiron Hei HK），加上 Google Fonts 的思源黑體、思源宋體、昭源宋體、霞鶩文楷。只存 id，不接受任意字體名稱或網址。

- 預設字體不發任何外部請求。選了其他字體，`AdminTheme` 才輸出該字體的 Google Fonts stylesheet（React 放進 `<head>` 並去重），`<style>` 多帶 `data-admin-font`，`admin-theme.css` 把 body 與明寫 `font-sans`/`font-heading` 的元素換字。
- 編輯器在開啟時用 effect 載入所有選項的 stylesheet，讓選項用自己的字體寫名字；字檔只在文字畫出來時才下載，不擋設定頁的首次繪製。
- CSP（Report-Only）已放行 `fonts.googleapis.com`（style-src）與 `fonts.gstatic.com`（font-src）。

## 側欄圖示

`icons: "solid"`（預設）是原本的 Heroicons 16 實心；`"outline"` 換成 Lucide 線條。`adminNavIcons.tsx` 裡每個圖示代號都同時對應兩套，manifest 的 `icon: "truck"` 不用改。`AdminTheme` 把已存的圖示組交給 `NavIcon`（`admin-icon-set.tsx` 的 context），編輯器預覽另外包一層草稿值。只影響側欄；後台其他地方本來就是 Lucide。

## 編輯器

設定頁「風格」是獨立分頁（`?tab=style`），不進核心設定那條捲動錨點。版面：預設風格 → 配色 → 字體 → 形狀在左，預覽在右並跟著捲動停在畫面裡；窄螢幕依序為預設風格、預覽、細部調整。預覽是一張縮小的訂單頁，用後台真正在用的輸入框、按鈕、`CoreTable` 與對話框。儲存與放棄走和核心設定同一條浮動儲存列（`SaveBar`）。

## Token contract

`src/lib/admin-theme.ts` 是設定 schema、preset、fallback 和變數產生器；`src/app/admin-theme.css` 是 shadcn/Intent token bridge。

| Token | 用途 |
| --- | --- |
| `--admin-ground`, `--admin-surface`, `--admin-ink` | 頁面底色、容器與文字 |
| `--admin-accent`, `--admin-accent-fg` | 既有主色及其上的文字 |
| `--admin-radius-scale` | 既有 8/12/14/20px 圓角按同一比例變化 |
| `--admin-radius-control/card/panel` | 新元件使用的圓角層級 |
| `--admin-shadow-card/panel` | 平面（透明）、細邊線；柔和 = `initial`，用元件原本的陰影 |
| `--admin-font` | 非預設字體的 font-family；預設是 `initial` |

純後台元件可以使用 `bg-surface`、`text-ink` 與 radius/shadow token，且一律要帶原本的值當 fallback（`shadow-[var(--admin-shadow-card,<原本的陰影>)]`）——預設風格下這些變數不存在。前後台共用元件必須保留原 class 名稱，再加 `admin:` variant，例如 `bg-white admin:bg-surface`；`admin:` 只在自訂風格時生效。

`--admin-shadow-card/panel` 只用在「卡片／面板的層次」。錯誤紅框、主色選取框、checkbox 邊框、底線這類有語意的陰影維持原本寫法，不接這個 token。這不只是保留預設顏色：站台 CSS 可能直接選取 `.bg-white` 等 class，移除 class 會破壞客製前台。

不要使用全域 `.bg-white` / `rounded-*` selector 來覆蓋第三方元件。Avatar、色票、狀態 pill 的圓形和 success/warning/danger 語意色維持原樣。第三方自行寫死 CSS 的頁面，需要透過同一套 token 漸進採用。

## 驗收

1. 舊站未設定主題時仍載入原主色。
2. 選 Paper & Ink、Sage、Clay、Atelier：只有預覽改變；可操作輸入框並開啟預覽對話框。
3. 調整主色、背景、surface、文字、圓角與層次後儲存，重新整理及跨後台路由仍維持設定。
4. 另一個後台分頁同步；關閉儲存權限/模擬失敗時保留草稿；非法值不能儲存。
5. 導向前台及登入頁，沒有 admin token 洩漏。共用元件的 public class 保持不變。
6. 桌面與 390px viewport 的編輯器、sidebar drawer、dialog 均可操作，body 不橫向溢出。
7. 重設 Paper & Ink、儲存、重新整理後持續生效。

V1 不包含深色模式、自訂 CSS、白名單以外的字體、個人主題、改動版面密度或公開網站 theme。

開發站（`next dev`）換頁或存檔後偶爾會閃一下沒有樣式的畫面：那是 dev server 熱更新時把整支 CSS 換成新的 `?v=` 版本，production 的 CSS 檔名固定，不會發生。
