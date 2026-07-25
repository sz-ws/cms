import { describe, it, expect, beforeEach, vi } from "vitest";

// 端到端:證明「路由零新增 —— POST /api/callback/cron:tick/cron 由既有 unified ingress
// 自動生效」。這串起 Part A(provides 接進 registry)+ Part B(cron provider):route
// 用 buildProviderRegistry 建 registry → getById("cron:tick","cron") 命中 cron
// extension 提供的 CronTickProvider → 驗簽 → handleCallback。
//
// 以 mock 隔離所有 I/O(D1/loader/jobs/settings/rate-limit),聚焦在「接線是否通」的
// 行為分支(404 未知 provider / 403 錯簽 / 200 正確簽)。

const SECRET = "route-cron-secret";

// db 不被 provider 建構期以外觸達；回傳空物件即可（scopedServices 會 eager 呼叫 db()）。
vi.mock("@/lib/db", () => ({ db: () => ({}) }));

// settings:provider 的 secret 讀取（ext.cron.secret）與 lastTick 寫入走這裡。
const settingsStore = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback?: unknown) =>
    key in settingsStore.values ? settingsStore.values[key] : fallback,
  setSettings: async (entries: Record<string, unknown>) => {
    Object.assign(settingsStore.values, entries);
  },
}));

// rate-limit:此測試不驗速率上限，一律放行。
vi.mock("@/lib/rate-limit", () => ({ hitRateLimit: async () => false }));

// jobs:handleCallback 會催動 runDueJobs —— spy 掉，避免碰 content 表。
const jobsState = vi.hoisted(() => ({ calls: [] as number[] }));
vi.mock("@/lib/jobs", () => ({
  runDueJobs: async (now: number) => {
    jobsState.calls.push(now);
    return [{ id: "publish-due", ok: true, processed: 0 }];
  },
}));

// loader:回傳只含「真實 cron extension」的 enabled runtime —— 驗證真正的 manifest
// provides 會被 buildProviderRegistry 接進 registry。
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const { cron } = await import("../extensions/cron");
  const rt = {
    enabled: [cron],
    all: [cron],
    hooks: new HookBus(),
    byId: (id: string) => (id === cron.id ? cron : undefined),
    isCompatible: () => true,
  };
  return { getExtRuntime: async () => rt };
});

import { POST } from "../src/app/api/callback/[capability]/[providerId]/route";

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ctx(capability: string, providerId: string) {
  return { params: Promise.resolve({ capability, providerId }) };
}

function req(body: string, sig?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== undefined) headers["x-signature"] = sig;
  return new Request("https://cms.test/api/callback/cron:tick/cron", {
    method: "POST",
    headers,
    body,
  });
}

const BODY = JSON.stringify({ ts: 1_700_000_000_000 });

describe("POST /api/callback/cron:tick/cron (unified ingress → cron provider)", () => {
  beforeEach(() => {
    settingsStore.values = { "ext.cron.secret": SECRET };
    jobsState.calls = [];
  });

  it("404 for an unknown providerId under cron:tick", async () => {
    const res = await POST(req(BODY), ctx("cron:tick", "nope"));
    expect(res.status).toBe(404);
    expect(jobsState.calls).toHaveLength(0);
  });

  it("403 on a bad signature (never reaches handleCallback)", async () => {
    const sig = await hmacHex("wrong", BODY);
    const res = await POST(req(BODY, sig), ctx("cron:tick", "cron"));
    expect(res.status).toBe(403);
    expect(jobsState.calls).toHaveLength(0);
  });

  it("403 when the signing secret is unset (fail closed)", async () => {
    settingsStore.values = {}; // 無 ext.cron.secret
    const sig = await hmacHex(SECRET, BODY);
    const res = await POST(req(BODY, sig), ctx("cron:tick", "cron"));
    expect(res.status).toBe(403);
    expect(jobsState.calls).toHaveLength(0);
  });

  it("413 for a chunked oversized body without buffering its trailing bytes", async () => {
    let chunksRead = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (chunksRead === 0) {
            chunksRead++;
            controller.enqueue(new Uint8Array(64_001));
            return;
          }
          throw new Error("reader must cancel before asking for trailing data");
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("https://cms.test/api/callback/cron:tick/cron", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const res = await POST(request, ctx("cron:tick", "cron"));

    expect(request.headers.has("content-length")).toBe(false);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    expect(cancelled).toBe(true);
    expect(chunksRead).toBe(1);
    expect(jobsState.calls).toHaveLength(0);
  });

  it("200 on a valid signature → runs due jobs + writes lastTick", async () => {
    const sig = await hmacHex(SECRET, BODY);
    const res = await POST(req(BODY, sig), ctx("cron:tick", "cron"));
    expect(res.status).toBe(200);
    expect(jobsState.calls).toHaveLength(1);
    expect(typeof settingsStore.values["ext.cron.lastTick"]).toBe("number");
  });
});
