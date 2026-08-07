import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// docs/spec-admin-agent.md §5.1(CORE_API 1.33.0):agent tool 結果的卡片式呈現。
//
// 這一檔要守住的是**「圖上的數字不可能是模型編的」**這件事的實作面:
//   · display 只由 tool 自己產出,而且只在 run() 成功、結果未截斷時才產出;
//   · 它會炸的時候要有保險絲(壞掉的卡不准連累一次已經跑完的查詢);
//   · 它回錯形狀的時候要被丟掉,而不是畫一半;
//   · write 提案永遠沒有 display —— 那不是靠 if 擋的,是因為 write 根本沒跑。
//
// 三個新的 core stats tool 對**真的 D1**跑一次:它們的賣點就是「數字來自真查詢」,
// 用假 provider 驗過等於沒驗。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
  getAI: () => undefined,
}));

// @/ext/loader 全 mock:aggregate.ts 靜態 import 它,而真實 loader 在 workers pool
// 載不起來(經 interpret → views → next/navigation)。同 agent-loop.test.ts 的處置。
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
  return {
    getExtRuntime: async () => ({
      enabled: [] as unknown[],
      all: [] as unknown[],
      hooks,
      byId: () => undefined,
      isCompatible: () => true,
      unavailableById: new Map<string, { kind: string }>(),
    }),
  };
});

import {
  AGENT_DISPLAY_MAX_SEGMENTS,
  AGENT_DISPLAY_MAX_SERIES,
  agentDisplaySchema,
} from "../src/ext/agent-display";
import type { AgentDisplay } from "../src/ext/agent-display";
import { coreAgentTools } from "../src/ext/agent-tools-core";
import {
  AgentToolRegistryImpl,
  defineAgentTool,
  invokeAgentTool,
} from "../src/ext/agent-tools";
import type { AgentTool, AgentToolCtx } from "../src/ext/agent-tools";
import { runAgentChat } from "../src/ext/agent-loop";
import type { AgentToolCallLog } from "../src/ext/agent-loop";
import {
  applyChatOutcome,
  emptyTranscript,
} from "../src/components/admin/agent/transcript";
import type { AiChatOptions, AiChatResult } from "../src/ext/providers/ai";
import { invalidateSettingsCache } from "../src/lib/settings";
import { z } from "zod";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ADMIN = {
  id: "u-admin",
  email: "admin@test.com",
  name: "Admin",
  role: "admin" as const,
  avatarKey: null,
};

const CTX = { user: ADMIN, services: {} } as unknown as AgentToolCtx;

const DISPLAY: AgentDisplay = {
  kind: "trend",
  preset: "trend-bars",
  data: { label: "Fixture", value: 3, series: [1, 1, 1] },
};

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS agent_audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL, user_email TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, args TEXT NOT NULL, ok INTEGER NOT NULL, result TEXT, error TEXT);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM agent_audit;");
  await d1().exec("DELETE FROM settings;");
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM declarative_extensions;");
  await d1().exec("DELETE FROM users;");
  invalidateSettingsCache();
});

// ---------------------------------------------------------------- 契約 schema

describe("agentDisplaySchema(不畫半殘的卡)", () => {
  it("兩個家族的合法形狀都收", () => {
    expect(agentDisplaySchema.safeParse(DISPLAY).success).toBe(true);
    expect(
      agentDisplaySchema.safeParse({
        kind: "proportion",
        preset: "bar-list",
        data: { label: "By type", segments: [{ id: "a", label: "A", value: 2 }] },
      }).success,
    ).toBe(true);
  });

  it("preset 必須屬於宣告的家族 —— 趨勢 preset 配佔比資料一律拒收", () => {
    expect(
      agentDisplaySchema.safeParse({
        kind: "proportion",
        preset: "trend-bars",
        data: { label: "x", segments: [{ id: "a", label: "A", value: 1 }] },
      }).success,
    ).toBe(false);
  });

  it("段數 / 序列長度 / 字串長度都有硬上限", () => {
    const segment = (i: number) => ({ id: `s${i}`, label: `S${i}`, value: i });
    const withSegments = (n: number) => ({
      kind: "proportion" as const,
      preset: "bar-list" as const,
      data: {
        label: "x",
        segments: Array.from({ length: n }, (_, i) => segment(i)),
      },
    });
    expect(
      agentDisplaySchema.safeParse(withSegments(AGENT_DISPLAY_MAX_SEGMENTS)).success,
    ).toBe(true);
    expect(
      agentDisplaySchema.safeParse(withSegments(AGENT_DISPLAY_MAX_SEGMENTS + 1)).success,
    ).toBe(false);

    const withSeries = (n: number) => ({
      kind: "trend" as const,
      preset: "trend-bars" as const,
      data: { label: "x", value: 1, series: Array.from({ length: n }, () => 1) },
    });
    expect(agentDisplaySchema.safeParse(withSeries(AGENT_DISPLAY_MAX_SERIES)).success).toBe(true);
    expect(
      agentDisplaySchema.safeParse(withSeries(AGENT_DISPLAY_MAX_SERIES + 1)).success,
    ).toBe(false);

    expect(
      agentDisplaySchema.safeParse({
        kind: "trend",
        preset: "stat-simple",
        data: { label: "x".repeat(500), value: 1 },
      }).success,
    ).toBe(false);
  });

  it("NaN / Infinity 進不來 —— 它們畫出來的是一張空白的圖,不是一張錯的圖", () => {
    expect(
      agentDisplaySchema.safeParse({
        kind: "trend",
        preset: "trend-bars",
        data: { label: "x", value: 1, series: [1, Number.NaN] },
      }).success,
    ).toBe(false);
    expect(
      agentDisplaySchema.safeParse({
        kind: "proportion",
        preset: "progress-ring",
        data: {
          label: "x",
          segments: [{ id: "a", label: "A", value: Number.POSITIVE_INFINITY }],
        },
      }).success,
    ).toBe(false);
  });

  it("多餘的鍵一律拒收(.strict)—— 安靜丟掉等於讓作者永遠不知道自己寫錯了", () => {
    expect(
      agentDisplaySchema.safeParse({ ...DISPLAY, extra: true }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ loop 接線

/** 一個一定會被 loop 執行的 read tool,display 由測試決定。 */
function readToolWith(
  display?: (result: unknown) => AgentDisplay | undefined,
): AgentTool {
  return defineAgentTool({
    name: "probe.read.run",
    description: "Probe.",
    kind: "read",
    schema: z.object({}).strict(),
    run: async () => ({ ok: true }),
    ...(display ? { display } : {}),
  });
}

function registryOf(tools: readonly AgentTool[]): AgentToolRegistryImpl {
  const registry = new AgentToolRegistryImpl();
  registry.registerAll(tools);
  return registry;
}

/** 第一步要求呼叫 `name`,第二步收工。 */
function chatCalling(name: string, args: unknown = {}): {
  chat: (opts: AiChatOptions) => Promise<AiChatResult>;
} {
  let step = 0;
  return {
    chat: async () => {
      step++;
      return step === 1
        ? {
            ok: true,
            text: "",
            toolUses: [{ id: "tu-1", name, input: args }],
          }
        : { ok: true, text: "done" };
    },
  };
}

async function runWith(
  tools: readonly AgentTool[],
  toolName: string,
): Promise<AgentToolCallLog[]> {
  const outcome = await runAgentChat({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "s",
    registry: registryOf(tools),
    ctx: CTX,
    ...chatCalling(toolName),
  });
  return outcome.toolCalls;
}

describe("agent-loop 的 display 接線", () => {
  it("正常情況:成功的 read tool 帶著它宣告的 display 進 log", async () => {
    const logs = await runWith([readToolWith(() => DISPLAY)], "probe.read.run");
    expect(logs).toHaveLength(1);
    expect(logs[0].ok).toBe(true);
    expect(logs[0].display).toEqual(DISPLAY);
  });

  it("保險絲:display throw → 那筆 log 沒有 display,但工具本身仍然成功", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = await runWith(
      [
        readToolWith(() => {
          throw new Error("boom");
        }),
      ],
      "probe.read.run",
    );
    spy.mockRestore();
    expect(logs).toHaveLength(1);
    // 這是整條規則的重點:壞掉的卡片不准把一次已經跑完的查詢一起帶走。
    expect(logs[0].ok).toBe(true);
    expect(logs[0].display).toBeUndefined();
  });

  it("守門:display 回不合法形狀 → 被丟掉,不會進 log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = await runWith(
      [
        readToolWith(
          () =>
            ({
              kind: "proportion",
              preset: "trend-bars", // 家族對不上
              data: { label: "x", segments: [] },
            }) as unknown as AgentDisplay,
        ),
      ],
      "probe.read.run",
    );
    expect(logs[0].ok).toBe(true);
    expect(logs[0].display).toBeUndefined();
    // 驗完才 restore:mockRestore 之後 spy 的呼叫紀錄就沒了。
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("沒宣告 display 的 tool → log 上根本沒有這個鍵(1.32.0 的形狀一字未改)", async () => {
    const logs = await runWith([readToolWith()], "probe.read.run");
    expect("display" in logs[0]).toBe(false);
  });

  it("回 undefined(資料空到畫不出東西)→ 也沒有 display,而且不吵", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = await runWith([readToolWith(() => undefined)], "probe.read.run");
    expect(logs[0].display).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("失敗的 tool 沒有 display —— 失敗的結果沒有東西可以畫", async () => {
    const failing: AgentTool = defineAgentTool({
      name: "probe.read.run",
      description: "Probe.",
      kind: "read",
      schema: z.object({}).strict(),
      run: async () => {
        throw new Error("nope");
      },
      display: () => DISPLAY,
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = await runWith([failing], "probe.read.run");
    spy.mockRestore();
    expect(logs[0].ok).toBe(false);
    expect(logs[0].display).toBeUndefined();
  });

  it("write 提案的 log 永遠沒有 display —— 因為 write 在 loop 內根本沒跑", async () => {
    const executed = vi.fn();
    const writeTool: AgentTool = defineAgentTool({
      name: "probe.write.run",
      description: "Probe write.",
      kind: "write",
      schema: z.object({}).strict(),
      run: async () => {
        executed();
        return { ok: true };
      },
      display: () => DISPLAY,
    });
    const outcome = await runAgentChat({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: "s",
      registry: registryOf([writeTool]),
      ctx: CTX,
      ...chatCalling("probe.write.run"),
    });
    expect(outcome.status).toBe("proposal");
    expect(executed).not.toHaveBeenCalled();
    expect(outcome.toolCalls.every((c) => c.display === undefined)).toBe(true);
  });

  it("display 只搭 outcome 走,不進串流事件", async () => {
    const events: string[] = [];
    const outcome = await runAgentChat({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: "s",
      registry: registryOf([readToolWith(() => DISPLAY)]),
      ctx: CTX,
      onEvent: (event) => events.push(JSON.stringify(event)),
      ...chatCalling("probe.read.run"),
    });
    expect(outcome.toolCalls[0].display).toEqual(DISPLAY);
    expect(events.some((e) => e.includes("display"))).toBe(false);
    expect(events.some((e) => e.includes("tool_done"))).toBe(true);
  });

  it("locale 一路傳到 display(確認卡摘要走的是同一條路)", async () => {
    const seen: string[] = [];
    const tool = defineAgentTool({
      name: "probe.read.run",
      description: "Probe.",
      kind: "read",
      schema: z.object({}).strict(),
      run: async () => ({ ok: true }),
      display: (_result, locale) => {
        seen.push(locale);
        return DISPLAY;
      },
    });
    await runAgentChat({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: "s",
      registry: registryOf([tool]),
      ctx: CTX,
      locale: "zh-Hant",
      ...chatCalling("probe.read.run"),
    });
    expect(seen).toEqual(["zh-Hant"]);
  });
});

// ------------------------------------------------------------- transcript 對位

describe("applyChatOutcome", () => {
  it("display 活著進到 toolCalls entry(面板拿得到卡片)", async () => {
    const outcome = await runAgentChat({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: "s",
      registry: registryOf([readToolWith(() => DISPLAY)]),
      ctx: CTX,
      ...chatCalling("probe.read.run"),
    });
    const state = applyChatOutcome(emptyTranscript(), outcome);
    const entry = state.entries.find((e) => e.kind === "toolCalls");
    expect(entry).toBeDefined();
    if (entry?.kind !== "toolCalls") throw new Error("unreachable");
    expect(entry.calls[0].display).toEqual(DISPLAY);
  });
});

// --------------------------------------------------------- 三個 core stats tool

function coreByName(): Map<string, AgentTool> {
  return new Map(coreAgentTools().map((t) => [t.name, t]));
}

const STATS_TOOLS = [
  "core.stats.overview",
  "core.stats.activity",
  "core.stats.storage",
] as const;

async function seedGallery(): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, version, manifest, enabled) VALUES (?,?,?,1)",
    )
    .bind(
      "gallery",
      "1.0.0",
      JSON.stringify({
        kind: "declarative",
        id: "gallery",
        name: "Gallery",
        version: "1.0.0",
        coreApi: "^1.28.0",
        contentTypes: [
          {
            name: "item",
            label: "Gallery item",
            fields: [{ key: "title", type: "text" }],
          },
        ],
      }),
    )
    .run();
}

async function seedEntries(
  count: number,
  status: "draft" | "published",
  createdAt: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await d1()
      .prepare(
        "INSERT INTO contents (id, type, locale, translation_group, slug, status, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        `c-${status}-${createdAt}-${i}`,
        "gallery.item",
        "en",
        `g-${status}-${createdAt}-${i}`,
        `${status}-${createdAt}-${i}`,
        status,
        JSON.stringify({ title: `Entry ${i}` }),
        createdAt,
        createdAt,
      )
      .run();
  }
}

describe("core stats tools(真 D1)", () => {
  it("三個都是 read —— 統計不該有任何一個能寫", () => {
    const tools = coreByName();
    for (const name of STATS_TOOLS) {
      expect(tools.get(name)?.kind).toBe("read");
    }
  });

  it("三個都宣告了 display", () => {
    const tools = coreByName();
    for (const name of STATS_TOOLS) {
      expect(typeof tools.get(name)?.display).toBe("function");
    }
  });

  it("core.stats.overview:數字來自真的 rows,display 是每個 type 一段", async () => {
    await seedGallery();
    await seedEntries(3, "published", Date.now());
    await seedEntries(2, "draft", Date.now());
    await d1()
      .prepare(
        "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?,?,?,?,?,?)",
      )
      .bind("u1", "a@test.com", "x", "A", "admin", Date.now())
      .run();

    const tool = coreByName().get("core.stats.overview")!;
    const res = await invokeAgentTool(tool, CTX, {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const result = res.result as {
      totalEntries: number;
      totalPublished: number;
      totalDrafts: number;
      typeCount: number;
      userCount: number;
      types: { type: string; label: string; total: number }[];
    };
    expect(result.totalEntries).toBe(5);
    expect(result.totalPublished).toBe(3);
    expect(result.totalDrafts).toBe(2);
    expect(result.typeCount).toBe(1);
    expect(result.userCount).toBe(1);
    expect(result.types[0].type).toBe("gallery.item");

    const display = tool.display!(res.result, "zh-Hant");
    expect(display).toBeDefined();
    expect(agentDisplaySchema.safeParse(display).success).toBe(true);
    expect(display?.kind).toBe("proportion");
    expect(display?.preset).toBe("bar-list");
    if (display?.kind !== "proportion") throw new Error("unreachable");
    expect(display.data.segments).toEqual([
      { id: "gallery.item", label: "Gallery item", value: 5 },
    ]);
  });

  it("core.stats.overview:一筆內容都沒有 → 結果仍然合法,但沒有卡片可畫", async () => {
    const tool = coreByName().get("core.stats.overview")!;
    const res = await invokeAgentTool(tool, CTX, {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect((res.result as { totalEntries: number }).totalEntries).toBe(0);
    // 沒有 content type = 沒有段落。畫一張空卡不如不畫。
    expect(tool.display!(res.result, "en")).toBeUndefined();
  });

  it("core.stats.activity:每日計數對得上,display 是 trend-bars", async () => {
    const now = Date.now();
    await seedEntries(2, "published", now - 1000);
    await seedEntries(1, "draft", now - 3 * 86_400_000);
    // 前一段窗(15–28 天前)的一筆,用來驗 previousWindowCreated 是反推得到的。
    await seedEntries(1, "draft", now - 20 * 86_400_000);

    const tool = coreByName().get("core.stats.activity")!;
    const res = await invokeAgentTool(tool, CTX, {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const result = res.result as {
      windowDays: number;
      entriesCreated: number;
      previousWindowCreated: number;
      change: { direction: string; amount: number };
      dailyCounts: number[];
    };
    expect(result.windowDays).toBe(14);
    expect(result.dailyCounts).toHaveLength(14);
    expect(result.entriesCreated).toBe(3);
    expect(result.dailyCounts.reduce((s, n) => s + n, 0)).toBe(3);
    expect(result.previousWindowCreated).toBe(1);
    expect(result.change).toEqual({ direction: "up", amount: 2 });

    const display = tool.display!(res.result, "zh-Hant");
    expect(agentDisplaySchema.safeParse(display).success).toBe(true);
    if (display?.kind !== "trend") throw new Error("unreachable");
    expect(display.preset).toBe("trend-bars");
    expect(display.data.value).toBe(3);
    expect(display.data.series).toEqual(result.dailyCounts);
    expect(display.data.delta).toEqual({
      value: 2,
      direction: "up",
      caption: "較前 14 天",
    });
    expect(display.data.label).toContain("近 14 天");
  });

  it("core.stats.storage:D1 大小 vs 配額,display 是 progress-ring", async () => {
    const tool = coreByName().get("core.stats.storage")!;
    const res = await invokeAgentTool(tool, CTX, {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const result = res.result as {
      available: boolean;
      plan?: string;
      usedBytes?: number;
      quotaBytes?: number;
      usedPercent?: number;
      quotaLabel?: string;
    };
    // miniflare 的 D1 也回報 meta.size_after,所以這裡斷言的是「真的量到了」而不是
    // 「量不到也算過」—— 有一天量不到時要當場失敗,不要靜靜地退成降級路徑。
    expect(result.available).toBe(true);
    expect(result.plan).toBe("free");
    expect(result.quotaBytes).toBe(500 * 1024 * 1024);
    expect(result.quotaLabel).toBe("500 MB");
    expect(result.usedBytes).toBeGreaterThan(0);
    expect(result.usedPercent).toBeGreaterThanOrEqual(0);

    const display = tool.display!(res.result, "zh-Hant");
    expect(agentDisplaySchema.safeParse(display).success).toBe(true);
    if (display?.kind !== "proportion") throw new Error("unreachable");
    expect(display.preset).toBe("progress-ring");
    expect(display.data.total).toBe(result.quotaBytes);
    expect(display.data.segments).toEqual([
      { id: "used", label: "已使用", value: result.usedBytes },
    ]);
    expect(display.data.label).toContain("資料庫");
  });

  it("core.stats.storage:paid 方案改用 10 GB 配額(設定真的被讀到)", async () => {
    await d1()
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .bind("core.d1.plan", JSON.stringify("paid"), Date.now())
      .run();
    invalidateSettingsCache();

    const tool = coreByName().get("core.stats.storage")!;
    const res = await invokeAgentTool(tool, CTX, {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const result = res.result as { available: boolean; quotaBytes?: number };
    expect(result.available).toBe(true);
    expect(result.quotaBytes).toBe(10 * 1024 * 1024 * 1024);
  });

  it("core.stats.storage:量不到 DB 大小時回 available:false,而且沒有卡片", async () => {
    const tool = coreByName().get("core.stats.storage")!;
    // 直接餵一份「量不到」的結果給 display —— 那條路在 miniflare 上跑不出來
    // (它一定量得到),但它是正式站 build 期真的會走到的分支。
    expect(tool.display!({ available: false, reason: "x" }, "en")).toBeUndefined();
  });

  it("statistics tool 走完整個 loop:log 上帶著卡片,而卡片的數字來自 D1", async () => {
    await seedGallery();
    await seedEntries(4, "published", Date.now());

    const registry = new AgentToolRegistryImpl();
    registry.registerAll(coreAgentTools());
    const outcome = await runAgentChat({
      messages: [{ role: "user", content: [{ type: "text", text: "how many?" }] }],
      system: "s",
      registry,
      ctx: CTX,
      locale: "en",
      ...chatCalling("core.stats.overview"),
    });

    const log = outcome.toolCalls.find((c) => c.toolName === "core.stats.overview");
    expect(log?.ok).toBe(true);
    expect(log?.display?.kind).toBe("proportion");
    if (log?.display?.kind !== "proportion") throw new Error("unreachable");
    expect(log.display.data.segments[0].value).toBe(4);
  });
});
