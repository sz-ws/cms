import { defineExtension } from "@/ext/types";
import { createManualPaymentProvider } from "@/ext/payment-kit";
import type { ManualInstructionsResult } from "@/ext/payment-kit";
import type { CheckoutRequest } from "@/ext/capabilities";
import type { CoreServices } from "@/ext/services";
import { BankTransferAdminPage } from "./admin-page";

// 銀行轉帳(匯款)extension —— payment capability 的第一個 **manual** provider
// (CORE_API 1.28.0 的 kind:"manual")。沒有 gateway、沒有回呼:createCheckout
// 回收款帳號等付款指示,結算入口是 admin 人工核帳(settleManual),走與刷卡
// 回呼同一段冪等結算 + payment:succeeded —— 消費端(shop)完全不需分辨。
//
// 對帳動線住在 shop extension 的「對帳佇列」(訂單末五碼在那裡);本 extension
// 的 admin 頁只有設定狀態與付款列一覽。

const ORDERS_TABLE = "ext_banktransfer_orders";

async function buildInstructions(
  services: CoreServices,
  req: CheckoutRequest,
): Promise<ManualInstructionsResult> {
  // ScopedSettings 收**完整** key(ext.<extId>.<key>)—— 只給區域名會 throw。
  const [bankName, bankCode, accountNumber, accountName] = await Promise.all([
    services.settings.get<string>("ext.banktransfer.bankName", ""),
    services.settings.get<string>("ext.banktransfer.bankCode", ""),
    services.settings.get<string>("ext.banktransfer.accountNumber", ""),
    services.settings.get<string>("ext.banktransfer.accountName", ""),
  ]);
  if (!bankName.trim() || !accountNumber.trim() || !accountName.trim()) {
    return { ok: false, error: "not_configured" };
  }
  return {
    ok: true,
    instructions: [
      {
        label: "銀行",
        value: bankCode.trim() ? `${bankName.trim()}(${bankCode.trim()})` : bankName.trim(),
      },
      { label: "帳號", value: accountNumber.trim() },
      { label: "戶名", value: accountName.trim() },
      { label: "金額", value: `NT$ ${req.amount.toLocaleString("zh-TW")}` },
      { label: "訂單編號", value: req.orderNo },
    ],
    note: "轉帳完成後,請回報您的匯款帳號末五碼,對帳完成即為您處理訂單。",
  };
}

export const banktransfer = defineExtension({
  id: "banktransfer",
  name: "銀行轉帳",
  version: "0.1.0",
  coreApi: "^1.28.0",
  description:
    "匯款收款(無金流閘道):結帳時出示收款帳號,款項由後台人工對帳後入帳。",
  icon: "landmark",
  settings: [
    {
      key: "bankName",
      label: "銀行名稱",
      description: "如「國泰世華銀行」。",
      type: "text",
      required: true,
      default: "",
    },
    {
      key: "bankCode",
      label: "銀行代碼",
      description: "三碼銀行代碼(如 013)。可留空。",
      type: "text",
      default: "",
    },
    {
      key: "accountNumber",
      label: "帳號",
      type: "text",
      required: true,
      default: "",
    },
    {
      key: "accountName",
      label: "戶名",
      type: "text",
      required: true,
      default: "",
    },
  ],
  migrations: [
    {
      id: "0001_orders",
      sql: `
        CREATE TABLE IF NOT EXISTS ext_banktransfer_orders (
          order_no TEXT PRIMARY KEY,
          amount INTEGER NOT NULL,
          description TEXT NOT NULL,
          email TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          trade_no TEXT,
          payment_type TEXT,
          pay_time TEXT,
          raw_result TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ext_banktransfer_orders_created
          ON ext_banktransfer_orders (created_at)
      `,
    },
  ],
  uninstall: [
    {
      id: "0001_drop_orders",
      sql: `
        DROP INDEX IF EXISTS idx_ext_banktransfer_orders_created;
        DROP TABLE IF EXISTS ext_banktransfer_orders
      `,
    },
  ],
  adminPages: [
    {
      slug: "",
      title: "銀行轉帳",
      component: BankTransferAdminPage,
    },
  ],
  provides: [
    {
      capability: "payment",
      id: "banktransfer",
      create: (services) =>
        createManualPaymentProvider({
          services,
          providerId: "banktransfer",
          table: ORDERS_TABLE,
          instructions: (req) => buildInstructions(services, req),
        }),
    },
  ],
});
