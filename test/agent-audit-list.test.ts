import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// listAgentAudit 的 binding-backed 整合測試(miniflare D1)。寫入端走真的
// recordAgentToolRun —— 讀取要能還原寫入端真正落下的形狀(ok 0/1 → boolean、
// result/error 互斥),而不是測一份自己手刻的假資料。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import {
  recordAgentToolRun,
  listAgentAudit,
  formatAuditCursor,
  parseAuditCursor,
  AGENT_AUDIT_PAGE_MAX,
} from "../src/ext/agent-audit";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const actor = { id: "u-admin", email: "admin@example.com" };

async function seed(
  n: number,
  shape: (i: number) => Partial<{
    tool: string;
    kind: "read" | "write";
    source: "chat" | "execute";
    ok: boolean;
  }> = () => ({}),
): Promise<void> {
  for (let i = 0; i < n; i++) {
    const s = shape(i);
    await recordAgentToolRun({
      actor,
      toolName: s.tool ?? `core.thing.list`,
      kind: s.kind ?? "read",
      source: s.source ?? "chat",
      args: { i },
      outcome:
        s.ok === false
          ? { ok: false, error: "boom", issues: [`issue ${i}`] }
          : { ok: true, result: { i } },
    });
  }
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS agent_audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL, user_email TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, args TEXT NOT NULL, ok INTEGER NOT NULL, result TEXT, error TEXT);",
  );
});

beforeEach(async () => {
  // 這張表在應用層是 append-only;測試隔離是唯一可以 DELETE 它的地方。
  await d1().exec("DELETE FROM agent_audit;");
});

describe("listAgentAudit", () => {
  it("returns newest first and maps ok/result/error faithfully", async () => {
    await seed(3, (i) => ({ tool: `t.${i}`, ok: i !== 1 }));
    const page = await listAgentAudit();
    expect(page.rows.map((r) => r.tool)).toEqual(["t.2", "t.1", "t.0"]);
    expect(page.nextCursor).toBeNull();

    const failed = page.rows[1];
    expect(failed.ok).toBe(false);
    expect(failed.result).toBeNull();
    expect(failed.error).toBe("boom: issue 1");

    const fine = page.rows[0];
    expect(fine.ok).toBe(true);
    expect(fine.error).toBeNull();
    expect(JSON.parse(fine.result!)).toEqual({ i: 2 });
    expect(JSON.parse(fine.args)).toEqual({ i: 2 });
    expect(fine.userEmail).toBe(actor.email);
  });

  it("filters by kind, source, ok and tool", async () => {
    await seed(6, (i) => ({
      tool: i % 2 ? "content.post.update" : "content.post.list",
      kind: i % 2 ? "write" : "read",
      source: i % 2 ? "execute" : "chat",
      ok: i !== 4,
    }));

    expect((await listAgentAudit({ kind: "write" })).rows).toHaveLength(3);
    expect((await listAgentAudit({ source: "chat" })).rows).toHaveLength(3);
    expect((await listAgentAudit({ ok: false })).rows).toHaveLength(1);
    expect((await listAgentAudit({ ok: true })).rows).toHaveLength(5);
    expect(
      (await listAgentAudit({ tool: "content.post.update", ok: true })).rows,
    ).toHaveLength(3);
    // 確認制的可查證形式:write 只出現在 execute。
    expect((await listAgentAudit({ kind: "write", source: "chat" })).rows).toEqual([]);
  });

  it("pages with a keyset cursor without gaps or repeats, even within one millisecond", async () => {
    // 同一毫秒塞 7 列:只靠 at 分頁會在這裡漏列或重複。
    const at = 1_700_000_000_000;
    for (let i = 0; i < 7; i++) {
      await d1()
        .prepare(
          "INSERT INTO agent_audit (id, at, user_id, user_email, tool, kind, source, args, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(`id-${i}`, at, actor.id, actor.email, `t.${i}`, "read", "chat", "{}")
        .run();
    }
    const seen: string[] = [];
    let cursor = undefined as undefined | { at: number; id: string };
    let pages = 0;
    for (;;) {
      const page = await listAgentAudit({ limit: 3, cursor });
      pages++;
      seen.push(...page.rows.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (pages > 10) throw new Error("cursor did not terminate");
    }
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual(
      Array.from({ length: 7 }, (_, i) => `id-${i}`).sort(),
    );
    expect(new Set(seen).size).toBe(7);
  });

  it("clamps limit to the page maximum", async () => {
    const page = await listAgentAudit({ limit: 10_000 });
    expect(page.rows.length).toBeLessThanOrEqual(AGENT_AUDIT_PAGE_MAX);
    // limit 0 / 負數不會變成「零列」的空頁。
    await seed(2);
    expect((await listAgentAudit({ limit: 0 })).rows).toHaveLength(1);
  });
});

describe("audit cursor encoding", () => {
  it("round-trips", () => {
    const c = { at: 1_700_000_000_123, id: "0f6a1e2c-9b1d-4c7e-8f2a-1b2c3d4e5f60" };
    expect(parseAuditCursor(formatAuditCursor(c))).toEqual(c);
  });

  it("rejects malformed input instead of throwing", () => {
    expect(parseAuditCursor(null)).toBeNull();
    expect(parseAuditCursor("")).toBeNull();
    expect(parseAuditCursor("abc")).toBeNull();
    expect(parseAuditCursor("123.")).toBeNull();
    expect(parseAuditCursor(".abc")).toBeNull();
    expect(parseAuditCursor("-5.0f6a1e2c-9b1d-4c7e-8f2a-1b2c3d4e5f60")).toBeNull();
    expect(parseAuditCursor("1.not-a-uuid")).toBeNull();
  });
});
