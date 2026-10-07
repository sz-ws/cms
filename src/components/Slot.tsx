import type { ReactNode } from "react";
import type { SlotParts, SlotRegistry, ViewPlan, ViewSlot } from "@/ext/slots";
import { SlotFillBoundary } from "./SlotFillBoundary";

// 畫面上的插槽(機制見 src/ext/slots.ts)。這個檔是伺服器端的:向當次請求的 runtime 要「誰填了什麼」。
//
// 伺服器元件裡直接放:
//   <Slot of={OrderSummary} props={{ orderNo: no }}>
//     <DefaultSummary orderNo={no} />        ← 沒有人換掉就畫這個
//   </Slot>
//
// 要放進 client 元件的地方(那裡沒辦法問伺服器):外層的伺服器元件先 `await slotParts(插槽, props)`,
// 把結果當 prop 傳進去,client 元件用 <SlotRegion parts={...}>預設內容</SlotRegion> 擺(components/SlotRegion.tsx)。
// 填的元件要用 client 才有的東西(例如目前開著哪一張訂單),由開插槽的那一方提供 hook。
//
// 每個填的元件各自包在 SlotFillBoundary 裡:一個畫壞了只少它一個;換掉或包起來的壞了就畫原本的內容。

// loader 用到才載入:插件的頁面檔會 import 這個檔,而 loader 連著宣告式插件的整套畫面元件 ——
// 靜態 import 的話,只是讀插件定義的地方(與它們的測試)也得把那一整串載進來。
async function requestSlots(): Promise<SlotRegistry> {
  const { getExtRuntime } = await import("@/ext/loader");
  return (await getExtRuntime()).slots;
}

function guarded<P extends object>(slotId: string, place: string, components: ViewPlan<P>["before"], props: P): ReactNode[] {
  return components.map((Fill, index) => (
    <SlotFillBoundary key={`${place}-${index}`} slot={slotId}>
      <Fill {...props} />
    </SlotFillBoundary>
  ));
}

/** 前面的、(換掉的 或 預設內容)、後面的,整塊再由裡到外包起來。 */
export async function Slot<P extends object>({ of, props, children }: { of: ViewSlot<P>; props: P; children?: ReactNode }): Promise<ReactNode> {
  const plan = (await requestSlots()).view(of);
  const Replace = plan.replace;
  let content: ReactNode = (
    <>
      {guarded(of.id, "before", plan.before, props)}
      {Replace ? (
        <SlotFillBoundary slot={of.id} fallback={children}>
          <Replace {...props} />
        </SlotFillBoundary>
      ) : (
        children
      )}
      {guarded(of.id, "after", plan.after, props)}
    </>
  );
  for (const Wrap of plan.wrap) {
    content = (
      <SlotFillBoundary slot={of.id} fallback={content}>
        <Wrap {...props}>{content}</Wrap>
      </SlotFillBoundary>
    );
  }
  return content;
}

/**
 * 給 client 元件用的:前面、後面、換掉的先畫成 element;包起來的傳元件本身(SlotParts 的說明)。
 * props 只能是伺服器這時就知道、而且能序列化的東西。
 */
export async function slotParts<P extends object>(slot: ViewSlot<P>, props: P): Promise<SlotParts> {
  const plan = (await requestSlots()).view(slot);
  const Replace = plan.replace;
  return {
    slot: slot.id,
    before: guarded(slot.id, "before", plan.before, props),
    after: guarded(slot.id, "after", plan.after, props),
    replace: Replace ? <Replace {...props} /> : null,
    wrap: plan.wrap as unknown as SlotParts["wrap"],
    props: props as Record<string, unknown>,
  };
}
