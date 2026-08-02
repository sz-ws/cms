// 結束狀態碼。獨立一個模組,讓 cli.ts 與 setup.ts 都能引用而不繞成循環相依。
// cli.ts 仍然 re-export `EXIT`,既有的 `import { EXIT } from "./cli.js"` 契約不變。

export const EXIT = {
  OK: 0,
  NOT_FOUND: 1, // <id> 找不到 / 缺 id / path traversal / 多源衝突
  FETCH_FAILED: 2, // 網路 / 404 / size cap
  DEST_EXISTS: 3, // extensions/<id>/ 已存在且無 --force
  PATCH_FAILED: 4, // registry.ts patch 失敗
  UNKNOWN: 5,
  // spec 的結束狀態表只到 5;6 是本 CLI 新增(spec 當時沒有 coreApi 檢查這一關)。
  // 獨立一碼的理由:「core 版本不合」在 CI 裡要能跟「抓檔失敗 / 找不到」分開處理。
  CORE_INCOMPATIBLE: 6, // entry.coreApi 不相容本機 CORE_API_VERSION

  // ---- setup 流程(7 起) ----
  // 同樣的理由:CI 要能分辨「你還沒登入」(可修)、「建資源失敗」(可能要重試)、
  // 「使用者自己按了取消」(不是錯誤)這三件完全不同的事。
  SETUP_PREREQ: 7, // 前置條件不足:未登入 wrangler / 讀不到 wrangler.jsonc
  SETUP_FAILED: 8, // 某個 wrangler 操作失敗
  SETUP_ABORTED: 9, // 使用者在確認關卡選擇中止

  // ---- preflight ----
  // 獨立一碼:predeploy 掛的是這支,而「必填設定沒填」跟「wrangler 掛了」在 CI 裡
  // 要分得開 —— 前者是使用者要去填東西,後者是環境問題。
  PREFLIGHT_BLOCKED: 10, // --gate 下有必填設定確認為空
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
