import type { HookName, HookHandler } from "./types";

// 03 §2:HookBus。
export class HookBus {
  private handlers = new Map<HookName, { extId: string; fn: HookHandler }[]>();

  register(extId: string, name: HookName, fn: HookHandler): void {
    const list = this.handlers.get(name) ?? [];
    list.push({ extId, fn });
    this.handlers.set(name, list);
  }

  /** action:依註冊順序執行,錯誤 catch 並 console.error,不中斷其他 handler */
  async doAction(name: HookName, ...args: unknown[]): Promise<void> {
    for (const h of this.handlers.get(name) ?? []) {
      try {
        await h.fn(...args);
      } catch (e) {
        console.error(`[hook:${name}] ext=${h.extId}`, e);
      }
    }
  }

  /** filter:值依序流過所有 handler;handler 拋錯則跳過該 handler */
  async applyFilters<T>(name: HookName, value: T, ...args: unknown[]): Promise<T> {
    let v = value;
    for (const h of this.handlers.get(name) ?? []) {
      try {
        v = await h.fn(v, ...args);
      } catch (e) {
        console.error(`[filter:${name}] ext=${h.extId}`, e);
      }
    }
    return v;
  }
}
