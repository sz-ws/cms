// commerce-kit:運費引擎的純計算層 —— **零依賴**(特別是不含 zod)。
//
// 拆檔理由(bundle 紀律):computeShippingOptions 同時被三處引用 ——
// 結帳頁(公開 client bundle,微站預算 <80kb)、運費編輯器的即時試算(admin
// client)、checkout handler(server)。schema 驗證只有 server/admin 儲存需要,
// zod 不該因此進公開 bundle。schema 與 parse 住 shipping.ts(以型別註記釘住
// 與本檔 interface 的一致性)。語意說明見 shipping.ts 檔頭。

export interface ShippingMethod {
  id: string;
  name: string;
  /** 基本運費(整數元)。 */
  base: number;
  enabled: boolean;
}

export interface ShippingRuleWhen {
  /** 只套用於這些配送方式(缺席 = 全部)。 */
  methods?: string[];
  minSubtotal?: number;
  maxSubtotal?: number;
  minQty?: number;
  maxQty?: number;
  /** 收件地區(縣市字串;引擎只做字串比對)。 */
  regions?: string[];
}

export type ShippingRuleEffect =
  | { type: "free" }
  | { type: "add"; amount: number }
  | { type: "override"; amount: number };

export interface ShippingRule {
  /** 人話名稱(「滿千免運」)—— 顯示在結帳頁與試算面板。 */
  name: string;
  enabled: boolean;
  when: ShippingRuleWhen;
  effect: ShippingRuleEffect;
}

export interface ShippingConfig {
  methods: ShippingMethod[];
  rules: ShippingRule[];
}

/** 試算輸入 —— subtotal/qty 來自購物車,region 來自結帳表單(可空)。 */
export interface ShippingQuoteInput {
  subtotal: number;
  qty: number;
  region?: string;
}

/** 單一配送方式的試算結果。 */
export interface ShippingOption {
  id: string;
  name: string;
  /** 套完規則的最終運費(≥ 0)。 */
  fee: number;
  /** 有套到的規則名(顯示給客人:「滿千免運」)。 */
  applied: string[];
}

function ruleMatches(
  rule: ShippingRule,
  methodId: string,
  input: ShippingQuoteInput,
): boolean {
  const w = rule.when;
  if (w.methods && !w.methods.includes(methodId)) return false;
  if (w.minSubtotal !== undefined && input.subtotal < w.minSubtotal) return false;
  if (w.maxSubtotal !== undefined && input.subtotal > w.maxSubtotal) return false;
  if (w.minQty !== undefined && input.qty < w.minQty) return false;
  if (w.maxQty !== undefined && input.qty > w.maxQty) return false;
  if (w.regions) {
    if (!input.region || !w.regions.includes(input.region)) return false;
  }
  return true;
}

/**
 * 對每個啟用的配送方式,依陣列順序套用規則算出最終運費(順序即優先序;
 * free 命中即終止該方式的後續規則)。結帳頁把整排選項列給客人挑 —— 這是運費
 * 與刷卡的關鍵差異:刷卡選一家 gateway,運費是**同時列出所有選項**。
 */
export function computeShippingOptions(
  input: ShippingQuoteInput,
  config: ShippingConfig,
): ShippingOption[] {
  return config.methods
    .filter((m) => m.enabled)
    .map((method) => {
      let fee = method.base;
      const applied: string[] = [];
      for (const rule of config.rules) {
        if (!rule.enabled || !ruleMatches(rule, method.id, input)) continue;
        applied.push(rule.name);
        if (rule.effect.type === "free") {
          fee = 0;
          break;
        }
        fee =
          rule.effect.type === "add" ? fee + rule.effect.amount : rule.effect.amount;
      }
      return { id: method.id, name: method.name, fee: Math.max(0, fee), applied };
    });
}
