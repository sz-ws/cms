// Suko CMS 支援一個選用的商業授權檢查擴充點(open-core 模式:core 本身完全
// 開源,商業授權部署可選擇性掛上一個定期回報授權狀態的模組)。這份型別檔案
// 定義該擴充點的公開介面 —— 純介面,不含任何實際驗證邏輯或伺服器位址,
// 公開追蹤對這個 repo 的誠實與可稽核性沒有壞處。
//
// 實際實作見 ./verify.local.ts(gitignored,不隨這個 repo 的 git 歷史散佈;
// 本機/commercial 部署若未提供該檔,build 時會自動產生 ./verify.ts 的
// community-mode stub —— 見 scripts/ensure-licensing-stub.mjs)。

export interface LicenseCheckResult {
  ok: boolean;
  /** "community"(預設/OSS)| 未來授權伺服器定義的其他 tier 字串。 */
  tier: string;
  /** 這次呼叫是否真的送出了 telemetry(community 模式恆為 false)。 */
  telemetrySent: boolean;
  /** 人類可讀的狀態說明,供未來 UI 顯示用(v1 未接 UI)。 */
  detail?: string;
}

export interface LicenseVerifier {
  /** 永不 throw(同 email/AI provider 的 never-throw 慣例)。 */
  checkIn(now: number): Promise<LicenseCheckResult>;
}
