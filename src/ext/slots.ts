import type { ComponentType, ReactNode } from "react";

// 插槽 —— 「可以被上層改的地方」只有這一種寫法。
//
//   1. 宣告:本體或插件在可以被改的地方放一個有名字的插槽。
//        export const OrderActions = defineSlot<{ orderNo: string }>("shop.order.actions");   // 畫面
//        export const SidebarItems = defineValueSlot<AdminMenuItem[]>("admin.sidebar.items");   // 值
//   2. 填:別的插件在自己的定義裡(Extension.fills)往插槽填東西。
//        fill(SidebarItems, (items) => [...items, mine])            // 值:把值改成什麼
//        fill(OrderActions, { after: PrintLabel })                  // 畫面:before / after / replace / wrap
//   3. 用:本體在那個地方向當次請求的 SlotRegistry(ExtRuntime.slots)要結果。
//        rt.slots.value(SidebarItems, items)      <Slot of={OrderActions} props={{ orderNo }}>預設內容</Slot>
//
// 先後照層:一般插件 → 代理商那一層(layer: "agency")→ 這個站自己(layer: "site");同一層照
// extensions/registry.ts 的順序,同一個插件裡照 fills 寫的順序。所以站台永遠蓋得過代理商,代理商
// 蓋得過一般插件,跟陣列怎麼排無關。
//
// 插槽的名字是全站識別:用點分開的小寫段落,本體的以 admin. / site. 開頭,插件的以自己的 id 開頭
// (例如 "agency-admin.placements")。同一個名字就是同一個插槽。
//
// 插槽管的是「上層改下層」:改一個值、在一塊畫面前後加東西、換掉它、包起來。不是每一種擴充都是這個:
// 別的插件靠它運作的服務(付款、庫存、結帳要多填什麼)是 provides / capability;一頁取代另一頁牽涉網址
// 與權限,是 AdminPage.replaces;宣告式(JSON)插件帶不了函式。那些照舊。
//
// 當次請求才有的資料(語言、登入的人、資料庫裡的東西)由開插槽的那一方先讀好,放進值或 props 一起傳:
// 填的函式是同步的,不自己去查。
//
// 這個檔不 import React 的執行期,也不碰資料庫:值的插槽在 lib 裡、測試裡都能直接用。

const SLOT_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** 值的插槽:一個值依序流過每個填的函式。V 只在型別上用。 */
export interface ValueSlot<V> {
  readonly kind: "value";
  readonly id: string;
  readonly __value?: V;
}

/** 畫面的插槽:P 是放插槽的地方給每個元件的 props。 */
export interface ViewSlot<P extends object> {
  readonly kind: "view";
  readonly id: string;
  readonly __props?: P;
}

// 宣告過的名字與種類。同一個名字宣告幾次都算同一個插槽(模組重新載入、照內容型別產生的一族插槽
// 都會這樣),但不能一邊當值、一邊當畫面。
const declared = new Map<string, "value" | "view">();

function declare(id: string, kind: "value" | "view"): string {
  if (!SLOT_ID_RE.test(id)) {
    throw new Error(`[slots] invalid slot id "${id}": use lowercase segments separated by dots, e.g. "admin.sidebar.items"`);
  }
  const known = declared.get(id);
  if (known && known !== kind) throw new Error(`[slots] "${id}" is already declared as a ${known} slot`);
  declared.set(id, kind);
  return id;
}

export function defineValueSlot<V>(id: string): ValueSlot<V> {
  return { kind: "value", id: declare(id, "value") };
}

export function defineSlot<P extends object = Record<string, never>>(id: string): ViewSlot<P> {
  return { kind: "view", id: declare(id, "view") };
}

/**
 * 填的函式拿到的第二個參數。slots:可以讀別的插槽(例如代理商那一層讀站台填給它的規則);
 * extId:這個填的是哪個插件的(記 log 時用)。
 */
export interface FillContext {
  slots: SlotRegistry;
  extId: string;
}

/** 畫面的插槽怎麼填,四選一。wrap 的元件多拿到 children(被包住的內容)。 */
export type ViewPlacement<P extends object> =
  | { before: ComponentType<P>; after?: never; replace?: never; wrap?: never }
  | { after: ComponentType<P>; before?: never; replace?: never; wrap?: never }
  | { replace: ComponentType<P>; before?: never; after?: never; wrap?: never }
  | { wrap: ComponentType<P & { children: ReactNode }>; before?: never; after?: never; replace?: never };

const PLACES = ["before", "after", "replace", "wrap"] as const;
type Place = (typeof PLACES)[number];

interface ValueFill {
  kind: "value";
  slotId: string;
  apply: (value: unknown, ctx: FillContext) => unknown;
}

interface ViewFill {
  kind: "view";
  slotId: string;
  place: Place;
  component: ComponentType<never>;
}

export type SlotFill = ValueFill | ViewFill;

export function fill<V>(slot: ValueSlot<V>, apply: (value: V, ctx: FillContext) => V): SlotFill;
export function fill<P extends object>(slot: ViewSlot<P>, placement: ViewPlacement<P>): SlotFill;
export function fill(slot: ValueSlot<unknown> | ViewSlot<object>, how: unknown): SlotFill {
  if (slot.kind === "value") {
    if (typeof how !== "function") throw new Error(`[slots] fill("${slot.id}") needs a function`);
    return { kind: "value", slotId: slot.id, apply: how as ValueFill["apply"] };
  }
  const placement = (how ?? {}) as Partial<Record<Place, ComponentType<never>>>;
  const given = PLACES.filter((place) => placement[place] != null);
  if (given.length !== 1) throw new Error(`[slots] fill("${slot.id}") needs exactly one of before / after / replace / wrap`);
  const [place] = given;
  return { kind: "view", slotId: slot.id, place, component: placement[place] as ComponentType<never> };
}

/** 一般插件不寫;代理商共用的那一層寫 "agency",這個站自己的寫 "site"。 */
export type SlotLayer = "agency" | "site";

const LAYER_RANK: Record<SlotLayer | "plugin", number> = { plugin: 0, agency: 1, site: 2 };

export interface SlotSource {
  extId: string;
  layer?: SlotLayer;
  fills?: readonly SlotFill[];
}

/** 插件定義 → SlotRegistry 要的來源(loader 與測試共用)。 */
export function slotSources(extensions: readonly { id: string; layer?: SlotLayer; fills?: readonly SlotFill[] }[]): SlotSource[] {
  return extensions.map((ext) => ({ extId: ext.id, layer: ext.layer, fills: ext.fills }));
}

/** 畫面的插槽解出來的結果:放插槽的地方照這個畫。 */
export interface ViewPlan<P extends object> {
  before: ComponentType<P>[];
  after: ComponentType<P>[];
  /** 有人換掉就畫它,沒有(null)就畫預設內容。 */
  replace: ComponentType<P> | null;
  /** 由裡到外。 */
  wrap: ComponentType<P & { children: ReactNode }>[];
}

/**
 * 畫面的插槽交給 client 元件時的樣子(components/Slot.tsx 的 slotParts 產生,<SlotRegion> 擺):
 * 前面、後面、換掉的是伺服器先畫好的 element。包起來的(wrap)不能先畫 —— 它的 children 是 client
 * 那一邊才有的預設內容 —— 所以傳的是元件本身與它的 props,由 SlotRegion 在 client 畫;因此填進
 * client 元件裡的 wrap 必須是 client 元件("use client"),props 必須能序列化。
 */
export interface SlotParts {
  /** 插槽的名字(出錯時記在 log 裡)。 */
  slot: string;
  before: ReactNode;
  after: ReactNode;
  replace: ReactNode | null;
  /** 由裡到外。 */
  wrap: ComponentType<Record<string, unknown> & { children: ReactNode }>[];
  /** 給 wrap 的 props(放插槽的地方在伺服器就知道的那些)。 */
  props: Record<string, unknown>;
}

export type SlotErrorReporter = (error: unknown, info: { slot: string; ext: string }) => void;

/** explain() 的一筆:哪個插件、哪一層、怎麼填(值的插槽是 "value")。 */
export interface SlotFillInfo {
  ext: string;
  layer: SlotLayer | "plugin";
  how: "value" | Place;
}

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

const logSlotError: SlotErrorReporter = (error, info) => {
  console.error(`[slot:${info.slot}] ext=${info.ext}`, error);
};

/** 當次請求裡所有啟用中的插件填了什麼。 */
export class SlotRegistry {
  private readonly fills = new Map<string, { extId: string; layer: SlotLayer | "plugin"; fill: SlotFill }[]>();
  private readonly resolving = new Set<string>();
  private readonly onError: SlotErrorReporter;

  constructor(sources: readonly SlotSource[], onError: SlotErrorReporter = logSlotError) {
    this.onError = onError;
    const ordered = sources
      .map((source, index) => ({ source, index }))
      .sort((a, b) => LAYER_RANK[a.source.layer ?? "plugin"] - LAYER_RANK[b.source.layer ?? "plugin"] || a.index - b.index);
    for (const { source } of ordered) {
      for (const entry of source.fills ?? []) {
        this.fills.set(entry.slotId, [...(this.fills.get(entry.slotId) ?? []), { extId: source.extId, layer: source.layer ?? "plugin", fill: entry }]);
      }
    }
  }

  /** 值依序流過每個填的函式。一個函式出錯就跳過它(回報),其他照常 —— 同 HookBus 的 filter。 */
  value<V>(slot: ValueSlot<V>, base: V): V {
    if (this.resolving.has(slot.id)) throw new Error(`[slots] "${slot.id}" is read while it is being filled`);
    this.resolving.add(slot.id);
    try {
      let value = base;
      for (const { extId, fill: entry } of this.fills.get(slot.id) ?? []) {
        if (entry.kind !== "value") continue;
        try {
          const next = entry.apply(value, { slots: this, extId });
          // 值的插槽是同步的:回傳 Promise 的函式會把 Promise 當成值塞進去,所以當作出錯跳過。
          if (isThenable(next)) throw new Error(`[slots] a fill of "${slot.id}" returned a promise; value fills must be synchronous`);
          value = next as V;
        } catch (error) {
          this.onError(error, { slot: slot.id, ext: extId });
        }
      }
      return value;
    } finally {
      this.resolving.delete(slot.id);
    }
  }

  /** 這個插槽照實際的先後有誰填、怎麼填 —— 查「這個值是誰改的」「這塊是誰加的」用。 */
  explain(slot: ValueSlot<unknown> | ViewSlot<object>): SlotFillInfo[] {
    return (this.fills.get(slot.id) ?? [])
      .filter(({ fill: entry }) => entry.kind === slot.kind)
      .map(({ extId, layer, fill: entry }) => ({ ext: extId, layer, how: entry.kind === "value" ? "value" : entry.place }));
  }

  view<P extends object>(slot: ViewSlot<P>): ViewPlan<P> {
    const plan: ViewPlan<P> = { before: [], after: [], replace: null, wrap: [] };
    for (const { fill: entry } of this.fills.get(slot.id) ?? []) {
      if (entry.kind !== "view") continue;
      const component = entry.component as unknown as ComponentType<P>;
      if (entry.place === "before") plan.before.push(component);
      else if (entry.place === "after") plan.after.push(component);
      else if (entry.place === "replace") plan.replace = component;
      else plan.wrap.push(component as unknown as ComponentType<P & { children: ReactNode }>);
    }
    return plan;
  }
}
