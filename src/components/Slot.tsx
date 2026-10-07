import type { ComponentType, ReactNode } from "react";
import { isNextSignal } from "@/ext/next-signals";
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
// 一個填的元件壞了只少它一個;換掉或包起來的壞了就畫原本的內容。分兩半:
//   - 伺服器上(讀資料失敗、程式丟例外):ServerFill 直接呼叫填的函式、當場接住,整頁照樣由伺服器畫完。
//     所以伺服器端的填法要是普通的函式(可以 async),不要用 hook。
//   - 瀏覽器上(client 元件、或填的元件裡面更深的地方):SlotFillBoundary。
// redirect()、notFound() 不算壞掉,兩邊都原樣往上丟(ext/next-signals.ts)。

// loader 用到才載入:插件的頁面檔會 import 這個檔,而 loader 連著宣告式插件的整套畫面元件 ——
// 靜態 import 的話,只是讀插件定義的地方(與它們的測試)也得把那一整串載進來。
async function requestSlots(): Promise<SlotRegistry> {
  const { getExtRuntime } = await import("@/ext/loader");
  return (await getExtRuntime()).slots;
}

const CLIENT_REFERENCE = Symbol.for("react.client.reference");

/** 可以在伺服器上直接呼叫的填法:普通的函式。client 元件(一個參照,不能呼叫)與 class 元件不算。 */
function isServerFunction<P extends object>(component: ComponentType<P>): component is (props: P) => ReactNode | Promise<ReactNode> {
  if (typeof component !== "function") return false;
  if ((component as { $$typeof?: symbol }).$$typeof === CLIENT_REFERENCE) return false;
  return !(component.prototype as { isReactComponent?: unknown } | undefined)?.isReactComponent;
}

/**
 * 在伺服器上畫一個填的元件:直接呼叫它,丟例外(同步或 async)就記下來、改畫 fallback(沒有就不畫)。
 * 回傳值可能是 Promise —— 伺服器元件可以;同步的填法照樣同步回傳。
 */
function ServerFill<P extends object>({ slot, of: Fill, props, fallback }: { slot: string; of: (props: P) => ReactNode | Promise<ReactNode>; props: P; fallback?: ReactNode }): ReactNode | Promise<ReactNode> {
  const failed = (error: unknown): ReactNode => {
    if (isNextSignal(error)) throw error;
    console.error(`[slot:${slot}] a fill failed on the server`, error);
    return fallback ?? null;
  };
  try {
    const output = Fill(props);
    return output instanceof Promise ? output.then((node) => node, failed) : output;
  } catch (error) {
    return failed(error);
  }
}

/** 一個填的元件:伺服器函式經 ServerFill,其餘照一般元件畫;外面都有 SlotFillBoundary。 */
function fillElement<P extends object>(slotId: string, Fill: ComponentType<P>, props: P, fallback?: ReactNode): ReactNode {
  return isServerFunction(Fill) ? <ServerFill slot={slotId} of={Fill} props={props} fallback={fallback} /> : <Fill {...props} />;
}

function guarded<P extends object>(slotId: string, place: string, components: ViewPlan<P>["before"], props: P): ReactNode[] {
  return components.map((Fill, index) => (
    <SlotFillBoundary key={`${place}-${index}`} slot={slotId}>
      {fillElement(slotId, Fill, props)}
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
          {fillElement(of.id, Replace, props, children)}
        </SlotFillBoundary>
      ) : (
        children
      )}
      {guarded(of.id, "after", plan.after, props)}
    </>
  );
  for (const Wrap of plan.wrap) {
    const inner = content;
    content = (
      <SlotFillBoundary slot={of.id} fallback={inner}>
        {fillElement(of.id, Wrap, { ...props, children: inner }, inner)}
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
    // 壞了的話這裡畫 null,<SlotRegion> 那邊會照「沒有人換掉」畫預設內容。
    replace: Replace ? fillElement(slot.id, Replace, props) : null,
    wrap: plan.wrap as unknown as SlotParts["wrap"],
    props: props as Record<string, unknown>,
  };
}
