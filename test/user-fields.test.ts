import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { userFields, USER_FIELD_MAX_LENGTH } from "../src/lib/user-fields";

// core 1.81.0 會員自訂資料(migrations/0026 的 user_fields)。miniflare D1。

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

beforeAll(async () => {
  await d1().prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)").run();
  await d1().prepare("CREATE TABLE IF NOT EXISTS user_fields (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, key))").run();
});

beforeEach(async () => {
  await d1().prepare("DELETE FROM user_fields").run();
  await d1().prepare("DELETE FROM users").run();
  await d1().prepare("INSERT INTO users (id) VALUES ('u1'), ('u2')").run();
});

describe("userFields", () => {
  it("stores and reads JSON values under the plugin's own names", async () => {
    const members = userFields(d1(), "members");
    await members.set("u1", { phone: "0900-000-000", region: "某縣", visits: 3, opted: true, extra: { a: 1 } });
    expect(await members.get("u1", ["phone", "region", "visits", "opted", "extra", "unknown"])).toEqual({ phone: "0900-000-000", region: "某縣", visits: 3, opted: true, extra: { a: 1 } });
    const raw = await d1().prepare("SELECT key FROM user_fields WHERE user_id = 'u1' ORDER BY key").all<{ key: string }>();
    expect(raw.results.map((r) => r.key)).toEqual(["members.extra", "members.opted", "members.phone", "members.region", "members.visits"]);
  });

  it("overwrites, and null or undefined removes a field; an empty string is kept as a value", async () => {
    const members = userFields(d1(), "members");
    await members.set("u1", { phone: "1", address: "A" });
    await members.set("u1", { phone: "2", address: null, region: "" });
    expect(await members.get("u1", ["phone", "address", "region"])).toEqual({ phone: "2", region: "" });
  });

  it("one plugin cannot read or write another's fields, and users are separate", async () => {
    await userFields(d1(), "members").set("u1", { phone: "1" });
    await userFields(d1(), "dealer").set("u1", { phone: "dealer's" });
    expect(await userFields(d1(), "members").get("u1", ["phone"])).toEqual({ phone: "1" });
    expect(await userFields(d1(), "dealer").get("u1", ["phone"])).toEqual({ phone: "dealer's" });
    expect(await userFields(d1(), "members").get("u2", ["phone"])).toEqual({});
  });

  it("refuses bad names, values that are too long, and a user that does not exist", async () => {
    expect(() => userFields(d1(), "Bad Name")).toThrow();
    const members = userFields(d1(), "members");
    await expect(members.get("u1", ["has.dot"])).rejects.toThrow();
    await expect(members.set("u1", { "x y": 1 })).rejects.toThrow();
    await expect(members.set("u1", { big: "x".repeat(USER_FIELD_MAX_LENGTH) })).rejects.toThrow();
    await expect(members.set("ghost", { phone: "1" })).rejects.toThrow();
  });

  it("deleting the user deletes their fields", async () => {
    await userFields(d1(), "members").set("u1", { phone: "1" });
    await d1().prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect((await d1().prepare("SELECT COUNT(*) AS n FROM user_fields").first<{ n: number }>())?.n).toBe(0);
  });
});
