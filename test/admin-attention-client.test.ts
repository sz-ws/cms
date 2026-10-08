import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 側欄怎麼問「哪幾頁有事在等」(src/components/admin/attention.tsx,1.77.0):掛上時、換頁、分頁回到前景、
// 有人說「剛處理完」(refreshAdminAttention)、平常每 120 秒。5 秒內問過就不再問(剛處理完的那一次例外);
// 只認最後出發的那一次;問不到就留著原本的。
//
// 這裡沒有瀏覽器:window 與 document 用 EventTarget 代替,時間用假的。

import {
  ADMIN_ATTENTION_EVENT,
  refreshAdminAttention,
  useAdminAttention,
  watchAdminAttention,
} from "../src/components/admin/attention";

type Counts = Readonly<Record<string, number>>;

interface FakePage {
  window: EventTarget;
  document: EventTarget & { visibilityState: "visible" | "hidden" };
  fetch: ReturnType<typeof vi.fn>;
}

let page: FakePage;
let errors: ReturnType<typeof vi.spyOn>;
/** 伺服器現在會回什麼;測試中途可以換。 */
let answer: () => Promise<Response>;

const ok = (counts: unknown) => async () => Response.json({ counts });
const show = (state: "visible" | "hidden") => {
  page.document.visibilityState = state;
  page.document.dispatchEvent(new Event("visibilitychange"));
};
/** 讓已經回來的回應跑完(fetch → json → 回報)。 */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  answer = ok({});
  page = {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { visibilityState: "visible" as const }),
    fetch: vi.fn(() => answer()),
  };
  vi.stubGlobal("window", page.window);
  vi.stubGlobal("document", page.document);
  vi.stubGlobal("fetch", page.fetch);
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function start() {
  const seen: Counts[] = [];
  const watch = watchAdminAttention((counts) => seen.push(counts));
  return { watch, seen };
}

describe("watchAdminAttention", () => {
  it("一開始問一次,把每一頁的件數交出去;不走任何快取", async () => {
    answer = ok({ "/admin/ext/orders": 3 });
    const { watch, seen } = start();
    watch.check();
    await settle();
    expect(page.fetch).toHaveBeenCalledTimes(1);
    expect(page.fetch).toHaveBeenCalledWith("/api/admin/attention", { cache: "no-store" });
    expect(seen).toEqual([{ "/admin/ext/orders": 3 }]);
    watch.stop();
  });

  it("5 秒內問過:先不問,滿 5 秒再問一次(中間催幾次都只問一次)", async () => {
    const { watch } = start();
    watch.check();
    await vi.advanceTimersByTimeAsync(1_000);
    watch.check();
    watch.check();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(page.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.fetch).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("超過 5 秒沒問:馬上問", async () => {
    const { watch } = start();
    watch.check();
    await vi.advanceTimersByTimeAsync(5_000);
    watch.check();
    expect(page.fetch).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("剛處理完一件事(refreshAdminAttention):馬上問,不管 5 秒", async () => {
    const { watch } = start();
    watch.check();
    await vi.advanceTimersByTimeAsync(100);
    refreshAdminAttention();
    expect(page.fetch).toHaveBeenCalledTimes(2);
    refreshAdminAttention();
    expect(page.fetch).toHaveBeenCalledTimes(3);
    watch.stop();
  });

  it("平常每 120 秒問一次", async () => {
    const { watch } = start();
    watch.check();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(page.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(page.fetch).toHaveBeenCalledTimes(3);
    watch.stop();
  });

  it("分頁在背景:不問;回到前景馬上問,之後照常每 120 秒", async () => {
    const { watch } = start();
    watch.check();
    await vi.advanceTimersByTimeAsync(10_000);
    show("hidden");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(page.fetch).toHaveBeenCalledTimes(1);
    show("visible");
    expect(page.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(page.fetch).toHaveBeenCalledTimes(3);
    watch.stop();
  });

  it("切出去又馬上切回來(5 秒內問過):等滿 5 秒才問", async () => {
    const { watch } = start();
    watch.check();
    await vi.advanceTimersByTimeAsync(1_000);
    show("hidden");
    show("visible");
    expect(page.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(page.fetch).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("只認最後出發的那一次:先出發、後回來的舊答案丟掉", async () => {
    const replies: ((counts: unknown) => void)[] = [];
    answer = () => new Promise<Response>((resolve) => replies.push((counts) => resolve(Response.json({ counts }))));
    const { watch, seen } = start();
    watch.check();
    refreshAdminAttention();
    expect(replies).toHaveLength(2);
    replies[1]({ "/admin/ext/orders": 1 });
    await settle();
    replies[0]({ "/admin/ext/orders": 9 });
    await settle();
    expect(seen).toEqual([{ "/admin/ext/orders": 1 }]);
    watch.stop();
  });

  it.each([
    ["連不上", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["伺服器說不行(401)", async () => Response.json({ error: "unauthorized" }, { status: 401 })],
    ["回的不是 JSON", async () => new Response("<html>", { status: 200 })],
    ["回的形狀不對", async () => Response.json({ counts: ["/admin"] })],
  ])("問不到(%s):留著原本的,只記一筆", async (_name, broken) => {
    answer = ok({ "/admin/ext/orders": 2 });
    const { watch, seen } = start();
    watch.check();
    await settle();
    answer = broken as () => Promise<Response>;
    refreshAdminAttention();
    await settle();
    expect(seen).toEqual([{ "/admin/ext/orders": 2 }]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain("[admin-attention]");
    watch.stop();
  });

  it("一直問不到:只在第一次記一筆;好了之後再壞才再記", async () => {
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    const { watch, seen } = start();
    watch.check();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(page.fetch).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenCalledTimes(1);
    answer = ok({ "/admin": 1 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(seen).toEqual([{ "/admin": 1 }]);
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(errors).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("伺服器說某一頁這次問不到(unknown):那一頁的點留著原本的;本來就沒有的不會多出來", async () => {
    answer = ok({ "/admin/ext/orders": 2, "/admin/ext/repairs": 1 });
    const { watch, seen } = start();
    watch.check();
    await settle();
    // 報修那一頁這次問不到;訂單那一頁處理完了(不在 counts 裡 = 沒有事)。
    answer = async () => Response.json({ counts: {}, unknown: ["/admin/ext/repairs", "/admin/ext/never-seen"] });
    refreshAdminAttention();
    await settle();
    expect(seen.at(-1)).toEqual({ "/admin/ext/repairs": 1 });
    // 下一次問到了:照答案。
    answer = ok({});
    refreshAdminAttention();
    await settle();
    expect(seen.at(-1)).toEqual({});
    // unknown 的形狀不對就當作沒有。
    answer = async () => Response.json({ counts: { "/admin/ext/orders": 1 }, unknown: "nope" });
    refreshAdminAttention();
    await settle();
    expect(seen.at(-1)).toEqual({ "/admin/ext/orders": 1 });
    watch.stop();
  });

  it("只收 1 以上的有限數字;其他的當作那一頁沒有事", async () => {
    answer = ok({ "/admin/ext/orders": 2, "/admin/ext/a": 0, "/admin/ext/b": -1, "/admin/ext/c": "3", "/admin/ext/d": null, "/admin/ext/e": 1.5 });
    const { watch, seen } = start();
    watch.check();
    await settle();
    expect(seen).toEqual([{ "/admin/ext/orders": 2, "/admin/ext/e": 1.5 }]);
    watch.stop();
  });

  it("停掉之後:不再問、不再聽、還在路上的答案也不交出去", async () => {
    const replies: ((counts: unknown) => void)[] = [];
    answer = () => new Promise<Response>((resolve) => replies.push((counts) => resolve(Response.json({ counts }))));
    const { watch, seen } = start();
    watch.check();
    watch.stop();
    replies[0]({ "/admin/ext/orders": 4 });
    await settle();
    refreshAdminAttention();
    show("hidden");
    show("visible");
    watch.check();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(page.fetch).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("refreshAdminAttention", () => {
  it("送出一個 window 事件", () => {
    const heard = vi.fn();
    page.window.addEventListener(ADMIN_ATTENTION_EVENT, heard);
    refreshAdminAttention();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(ADMIN_ATTENTION_EVENT).toBe("admin:attention");
  });

  it("沒有側欄在聽:什麼都不會發生", () => {
    expect(() => refreshAdminAttention()).not.toThrow();
    expect(page.fetch).not.toHaveBeenCalled();
  });

  it("在伺服器上(沒有 window):什麼都不做", () => {
    vi.unstubAllGlobals();
    expect(typeof window).toBe("undefined");
    expect(() => refreshAdminAttention()).not.toThrow();
  });
});

describe("useAdminAttention", () => {
  // 這裡沒有 DOM,effect 不會跑:只確認第一次畫出來是空的(問的節奏在上面的 watchAdminAttention 測)。
  it("第一次畫出來沒有件數;關掉(訪客的側欄)也一樣", () => {
    function Probe({ enabled }: { enabled?: boolean }) {
      return createElement("p", null, JSON.stringify(useAdminAttention("/admin", enabled)));
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<p>{}</p>");
    expect(renderToStaticMarkup(createElement(Probe, { enabled: false }))).toBe("<p>{}</p>");
  });
});
