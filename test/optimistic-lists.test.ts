import { describe, it, expect } from "vitest";
import { stableReducer } from "../src/lib/optimistic";
import {
  applyBulkAction,
  type BulkAction,
} from "../src/ext/dx/views/collection/optimistic";
import {
  applyInboxAction,
  type InboxAction,
} from "../src/ext/dx/views/inbox-optimistic";
import type { InboxRowDTO } from "../src/ext/dx/views/InboxTable";
import { applyUsersAction } from "../src/app/(admin)/admin/users/users-optimistic";
import type { UserRecord } from "../src/app/(admin)/admin/users/UsersTable";
import { applyExtensionsAction } from "../src/app/(admin)/admin/extensions/extensions-optimistic";
import type { ExtensionRow } from "../src/app/(admin)/admin/extensions/ExtensionsManager";

// 後台列表的樂觀更新(useOptimistic 的 reducer)。元件本身在 workers pool 裡跑不了
// transition,這裡守兩件事:
//   1. 每個 reducer 算出來的結果跟 server 會回的一樣 —— 否則 refresh 回來畫面會跳;
//   2. stableReducer 讓「同一份 state 套同一個 action」永遠是同一個物件 —— React 在
//      transition 期間每次 render 都重跑 reducer,參照一變,sheet 的 held 比對就會
//      無限 re-render(src/lib/optimistic.ts 的檔頭)。

describe("stableReducer", () => {
  const base = [{ id: "a", n: 1 }];
  const bump = { by: 1 };
  let calls = 0;
  const reduce = stableReducer((rows: typeof base, a: typeof bump) => {
    calls++;
    return rows.map((r) => ({ ...r, n: r.n + a.by }));
  });

  it("同一份 state 套同一個 action:結果是同一個物件,reducer 只跑一次", () => {
    calls = 0;
    const first = reduce(base, bump);
    const again = reduce(base, bump); // 模擬 transition 期間的下一次 render
    expect(again).toBe(first);
    expect(first[0]).toBe(again[0]);
    expect(calls).toBe(1);
  });

  it("換了 action 或換了 state(server 資料回來)才重算", () => {
    const first = reduce(base, bump);
    expect(reduce(base, { by: 1 })).not.toBe(first);
    const fresh = [{ id: "a", n: 1 }];
    expect(reduce(fresh, bump)).not.toBe(first);
  });

  it("連續多個 action 疊起來也穩定(每一層都命中快取)", () => {
    const second = { by: 10 };
    const once = reduce(reduce(base, bump), second);
    const twice = reduce(reduce(base, bump), second);
    expect(twice).toBe(once);
    expect(once[0].n).toBe(12);
  });
});

describe("applyBulkAction(collection 批次動作)", () => {
  const rows = [
    { id: "a", status: "draft" },
    { id: "b", status: "draft" },
    { id: "c", status: "published" },
  ];

  it("改狀態:目標列換上新狀態並標 pending,其餘列原封不動(同一個物件)", () => {
    const action: BulkAction = { kind: "status", ids: ["a", "b"], status: "published" };
    const next = applyBulkAction(rows, action);
    expect(next.map((r) => [r.id, r.status, r.pending ?? false])).toEqual([
      ["a", "published", true],
      ["b", "published", true],
      ["c", "published", false],
    ]);
    expect(next[2]).toBe(rows[2]);
  });

  it("刪除:目標列直接拿掉", () => {
    const next = applyBulkAction(rows, { kind: "delete", ids: ["b"] });
    expect(next.map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("applyInboxAction(收件匣)", () => {
  const row = (id: string, state: InboxRowDTO["state"], repliedAt: number | null = null): InboxRowDTO => ({
    id,
    state,
    repliedAt,
    createdAt: 1,
    cells: [],
    detail: [],
  });
  const rows = [row("m1", "unread"), row("m2", "read", 500)];
  const patch = (a: Omit<Extract<InboxAction, { kind: "patch" }>, "kind" | "at">): InboxAction => ({
    kind: "patch",
    at: 1000,
    ...a,
  });

  it("開啟即已讀", () => {
    expect(applyInboxAction(rows, patch({ id: "m1", state: "read" }))[0].state).toBe("read");
  });

  it("未讀被標已回覆會順便變已讀(同 server 的 setSubmissionReplied)", () => {
    const [m1] = applyInboxAction(rows, patch({ id: "m1", replied: true }));
    expect(m1.state).toBe("read");
    expect(m1.repliedAt).toBe(1000);
  });

  it("取消已回覆:repliedAt 清空,狀態不動", () => {
    const [, m2] = applyInboxAction(rows, patch({ id: "m2", replied: false }));
    expect(m2).toMatchObject({ state: "read", repliedAt: null });
  });

  it("replied 與 state 併送時,明講的 state 贏(同 server 的套用順序)", () => {
    const [m1] = applyInboxAction(rows, patch({ id: "m1", replied: true, state: "archived" }));
    expect(m1.state).toBe("archived");
  });

  it("刪除:列拿掉,其他列同一個物件", () => {
    const next = applyInboxAction(rows, { kind: "delete", id: "m1" });
    expect(next).toEqual([rows[1]]);
    expect(next[0]).toBe(rows[1]);
  });
});

describe("applyUsersAction(成員)", () => {
  const user = (id: string, role: UserRecord["role"]): UserRecord => ({
    id,
    email: `${id}@example.com`,
    name: id,
    role,
    createdAt: 1,
    passkeys: 0,
    lastActiveAt: null,
  });
  const users = [user("u1", "admin"), user("u2", "editor")];

  it("upsert 既有成員:原位置換掉(順序不變)", () => {
    const next = applyUsersAction(users, { kind: "upsert", user: user("u2", "guest") });
    expect(next.map((u) => [u.id, u.role])).toEqual([
      ["u1", "admin"],
      ["u2", "guest"],
    ]);
  });

  it("upsert 新成員:接在最後", () => {
    const next = applyUsersAction(users, { kind: "upsert", user: user("u3", "editor") });
    expect(next.map((u) => u.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("remove", () => {
    expect(applyUsersAction(users, { kind: "remove", id: "u1" }).map((u) => u.id)).toEqual(["u2"]);
  });
});

describe("applyExtensionsAction(已安裝列表)", () => {
  const ext = (id: string, kind: ExtensionRow["kind"], enabled: boolean): ExtensionRow => ({
    id,
    name: id,
    version: "1.0.0",
    enabled,
    installed: true,
    kind,
    issue: null,
  });
  const rows = [ext("shop", "code", true), ext("faq", "declarative", false)];

  it("啟用 / 停用:換 enabled;停用不動 installed", () => {
    expect(applyExtensionsAction(rows, { id: "faq", action: "enable" })[1].enabled).toBe(true);
    expect(applyExtensionsAction(rows, { id: "shop", action: "disable" })[0]).toMatchObject({
      enabled: false,
      installed: true,
    });
  });

  it("啟用還沒裝的 code extension:順便變成已安裝(server 端啟用即安裝)", () => {
    const fresh = [{ ...ext("cron", "code", false), installed: false }];
    expect(applyExtensionsAction(fresh, { id: "cron", action: "enable" })[0]).toMatchObject({
      enabled: true,
      installed: true,
    });
  });

  it("移除 code extension:留在列表上(registry 的一員),變成未安裝、未啟用", () => {
    const [shop] = applyExtensionsAction(rows, { id: "shop", action: "uninstall" });
    expect(shop).toMatchObject({ id: "shop", installed: false, enabled: false });
  });

  it("移除 declarative extension:列消失", () => {
    const next = applyExtensionsAction(rows, { id: "faq", action: "uninstall" });
    expect(next.map((r) => r.id)).toEqual(["shop"]);
  });
});
