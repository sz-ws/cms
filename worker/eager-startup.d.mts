// eager-startup.mjs 不匯出任何東西,只在載入時做事(見該檔說明)。
//
// 這個宣告檔讓 tsc 停在這裡:沒有它,tsc(allowJs)會順著那支 .mjs 把 16 MB 的
// .open-next/server-functions/default/handler.mjs 整個載進型別程式。
export {};
