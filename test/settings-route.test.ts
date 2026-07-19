import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  writes: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/auth", () => ({
  requireAuth: async () => ({ id: "admin", role: "admin" }),
  authErrorResponse: () => null,
}));

vi.mock("@/lib/security", () => ({
  assertSameOrigin: () => undefined,
  originErrorResponse: () => null,
}));

vi.mock("@/lib/settings", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/settings")>();
  const fields = new Map([
    ["core.count", { key: "core.count", label: "Count", type: "number", default: 0 }],
    [
      "ext.demo.apiKey",
      {
        key: "apiKey",
        label: "API key",
        type: "text",
        required: true,
        default: "",
      },
    ],
    [
      "ext.demo.mode",
      {
        key: "mode",
        label: "Mode",
        type: "select",
        options: [{ value: "safe", label: "Safe" }],
        default: "safe",
      },
    ],
    [
      "core.registrySources",
      {
        key: "core.registrySources",
        label: "Sources",
        type: "textarea",
        default: [],
      },
    ],
  ]);
  return {
    ...actual,
    allowedSettingKeys: async () => new Set(fields.keys()),
    allowedSettingFields: async () => fields,
    setSettings: async (entries: Record<string, unknown>) => {
      state.writes.push(entries);
    },
    splitRegistrySourceTokens: async (value: unknown) => ({
      "core.registrySources": value,
      "core.registryTokens": "{}",
    }),
  };
});

import { PUT } from "../src/app/api/settings/route";

function request(entries: Record<string, unknown>): Request {
  return new Request("https://cms.test/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: "https://cms.test" },
    body: JSON.stringify({ entries }),
  });
}

beforeEach(() => {
  state.writes = [];
});

describe("PUT /api/settings value contract", () => {
  it.each([
    [{ "core.count": "3" }, "core.count", "expected_number"],
    [{ "ext.demo.apiKey": "  " }, "ext.demo.apiKey", "required"],
    [{ "ext.demo.mode": "fast" }, "ext.demo.mode", "invalid_option"],
  ])("rejects invalid values without persistence", async (entries, key, code) => {
    const response = await PUT(request(entries));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_values",
      fields: [{ key, code }],
    });
    expect(state.writes).toEqual([]);
  });

  it("rejects malformed registry sources before token splitting", async () => {
    const response = await PUT(request({ "core.registrySources": "invalid" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_values",
      fields: [{ key: "core.registrySources", code: "invalid_format" }],
    });
    expect(state.writes).toEqual([]);
  });

  it("persists valid values", async () => {
    const entries = { "core.count": 3, "ext.demo.mode": "safe" };
    const response = await PUT(request(entries));
    expect(response.status).toBe(200);
    expect(state.writes).toEqual([entries]);
  });
});
