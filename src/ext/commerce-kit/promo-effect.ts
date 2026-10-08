import type { Promo } from "./promo";

// commerce-kit:一個優惠碼的效果寫成一句話(後台列表,以及別的插件要列出優惠碼時)。沒有 React。

/** 打折的說法:折 10% = 打 9 折,折 15% = 打 85 折(店家和客人都這樣講)。 */
function percentEffect(percentOff: number): string {
  if (percentOff >= 100) return "全額折抵";
  const rest = Math.round((100 - percentOff) * 100) / 100;
  return `打 ${rest % 10 === 0 ? rest / 10 : rest} 折`;
}

/** 打 9 折、折抵 NT$100、免運。money:把金額寫成站台貨幣的函式(例如 formatMoney 配 useSiteCurrency)。 */
export function promoEffect(promo: Pick<Promo, "type" | "value">, money: (amount: number) => string): string {
  if (promo.type === "percent") return percentEffect(promo.value);
  if (promo.type === "flat") return `折抵 ${money(promo.value)}`;
  return "免運";
}
