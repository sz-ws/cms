import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.40.0:紀錄狀態組(ext/record-status.ts)、站台 slot 的收斂,與每一筆在某個狀態下的
// 描述(lib/record-status-notes.ts + /api/record-status/notes)。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const authState = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string; role: "admin" | "editor" },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async (role?: "admin") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (role && authState.user.role !== role) throw new actual.AuthError(403);
      return authState.user;
    },
  };
});

const ORDER_SET = {
  id: "orders",
  statuses: {
    pending_payment: { label: { en: "Awaiting payment", "zh-Hant": "待付款" }, tone: "amber" as const },
    paid: { label: "已付款", tone: "green" as const },
    cancelled: { label: "已取消" },
  },
};
vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({ enabled: [{ id: "shop-operations", statusSets: [ORDER_SET] }] }),
}));

import {
  normalizeStatusSets,
  resolveStatusSets,
} from "../src/ext/record-status";
import { defineExtension } from "../src/ext/types";
import { getStatusNotes, setStatusNote } from "../src/lib/record-status-notes";
import { GET, PUT } from "../src/app/api/record-status/notes/route";

const d1 = () => (env as { DB: D1Database }).DB;
const zh = (value: string | { en?: string; "zh-Hant"?: string }) =>
  typeof value === "string" ? value : value["zh-Hant"];

describe("resolveStatusSets / normalizeStatusSets", () => {
  const base = resolveStatusSets([{ id: "shop-operations", statusSets: [ORDER_SET] }], zh);

  it("依語系解析名稱,色調缺省 neutral", () => {
    expect(base["shop-operations:orders"]).toEqual({
      pending_payment: { label: "待付款", tone: "amber" },
      paid: { label: "已付款", tone: "green" },
      cancelled: { label: "已取消", tone: "neutral" },
    });
  });

  it("站台可以改名、補描述、換色調", () => {
    const out = normalizeStatusSets(
      {
        "shop-operations:orders": {
          pending_payment: { label: "未匯款" },
          paid: { addon: "付款成功,待後續處理", tone: "accent" },
        },
      },
      base,
    );
    expect(out["shop-operations:orders"].pending_payment).toEqual({ label: "未匯款", tone: "amber" });
    expect(out["shop-operations:orders"].paid).toEqual({ label: "已付款", tone: "accent", addon: "付款成功,待後續處理" });
  });

  it("不能憑空加狀態或狀態組;壞欄位退回原值;長度有上限", () => {
    const out = normalizeStatusSets(
      {
        "shop-operations:orders": {
          invented: { label: "新狀態" },
          paid: { label: "  ", tone: "rainbow", addon: "x".repeat(500) },
        },
        "ghost:set": { a: { label: "A" } },
      },
      base,
    );
    expect(Object.keys(out)).toEqual(["shop-operations:orders"]);
    expect(out["shop-operations:orders"].invented).toBeUndefined();
    expect(out["shop-operations:orders"].paid.label).toBe("已付款");
    expect(out["shop-operations:orders"].paid.tone).toBe("green");
    expect(out["shop-operations:orders"].paid.addon).toHaveLength(200);
    expect(normalizeStatusSets(null, base)).toBe(base);
  });

  it("defineExtension 驗證 statusSets", () => {
    const ext = { id: "demo", name: "Demo", version: "0.1.0", coreApi: "^1.40.0" };
    expect(() => defineExtension({ ...ext, statusSets: [ORDER_SET] })).not.toThrow();
    expect(() => defineExtension({ ...ext, coreApi: "^1.39.0", statusSets: [ORDER_SET] })).toThrow(/1\.40\.0/);
    expect(() => defineExtension({ ...ext, statusSets: [{ id: "Bad Id", statuses: {} }] })).toThrow();
    expect(() =>
      defineExtension({ ...ext, statusSets: [{ id: "orders", statuses: { paid: { label: "x", tone: "pink" } } }] as never }),
    ).toThrow();
  });
});

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS record_status_notes (status_set TEXT NOT NULL, record_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, updated_by TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(status_set, record_id, status));",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM record_status_notes;");
  authState.user = { id: "u-admin", email: "a@example.com", name: "Admin", role: "admin" };
});

describe("每一筆在某個狀態下的描述(lib)", () => {
  it("設定、覆寫、清除", async () => {
    await setStatusNote("shop-operations:orders", "SM1", "paid", "待後續處理", "u-admin");
    await setStatusNote("shop-operations:orders", "SM1", "paid", "  無效訂單 ", "u-admin");
    const notes = await getStatusNotes("shop-operations:orders", ["SM1", "SM2"]);
    expect(Object.keys(notes)).toEqual(["SM1"]);
    expect(notes.SM1.paid).toMatchObject({ note: "無效訂單", updatedBy: "u-admin" });
    expect(await setStatusNote("shop-operations:orders", "SM1", "paid", "", "u-admin")).toBeNull();
    expect(await getStatusNotes("shop-operations:orders", ["SM1"])).toEqual({});
  });

  it("每個狀態各一段:換了狀態,舊階段的描述還在但不是這個狀態的", async () => {
    await setStatusNote("shop-operations:orders", "SM3", "pending_payment", "客戶說週五匯", null);
    await setStatusNote("shop-operations:orders", "SM3", "paid", "等冷凍配送排程", null);
    const notes = await getStatusNotes("shop-operations:orders", ["SM3"]);
    expect(notes.SM3.pending_payment.note).toBe("客戶說週五匯");
    expect(notes.SM3.paid.note).toBe("等冷凍配送排程");
    expect(notes.SM3.cancelled).toBeUndefined();
  });

  it("不同狀態組互不干擾;壞的狀態值被擋下", async () => {
    await setStatusNote("shop-operations:orders", "X1", "paid", "A", null);
    await setStatusNote("dealer:orders", "X1", "paid", "B", null);
    expect((await getStatusNotes("dealer:orders", ["X1"])).X1.paid.note).toBe("B");
    await expect(setStatusNote("dealer:orders", "X1", "not a status", "C", null)).rejects.toThrow(/status/);
  });
});

const url = "http://localhost/api/record-status/notes";
const put = (body: unknown, origin = "http://localhost") =>
  PUT(new Request(url, { method: "PUT", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body) }));

describe("/api/record-status/notes", () => {
  it("admin 帶紀錄 id、狀態與描述就能設定,再讀回來", async () => {
    const res = await put({ set: "shop-operations:orders", id: "SM9", status: "paid", note: "待後續處理" });
    expect(res.status).toBe(200);
    const got = await GET(new Request(`${url}?set=shop-operations:orders&ids=SM9,SM10`));
    const body = (await got.json()) as { notes: Record<string, Record<string, { note: string }>> };
    expect(body.notes.SM9.paid.note).toBe("待後續處理");
    expect(body.notes.SM10).toBeUndefined();
  });

  it("沒宣告過的狀態組 404、狀態 400;少了狀態或太長 400;跨站 403;非 admin 403", async () => {
    const ok = { set: "shop-operations:orders", id: "A", status: "paid", note: "x" };
    expect((await put({ ...ok, set: "ghost:orders" })).status).toBe(404);
    const unknown = await put({ ...ok, status: "shipped" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "unknown_status" });
    expect((await put({ set: ok.set, id: "A", note: "x" })).status).toBe(400);
    expect((await put({ ...ok, note: "x".repeat(201) })).status).toBe(400);
    expect((await put(ok, "https://evil.example")).status).toBe(403);
    authState.user = { id: "u-ed", email: "e@example.com", name: "Ed", role: "editor" };
    expect((await put(ok)).status).toBe(403);
  });
});
