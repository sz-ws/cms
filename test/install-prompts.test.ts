import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:test";

// setExtensionSettingsRaw 的 binding-backed 整合測試(miniflare D1)。db() 走
// @opennextjs/cloudflare getCloudflareContext(pool-workers 內不可用),所以 mock
// @/lib/cf 讓 getDB/getEnv 直接回傳 cloudflare:test 的 env(同
// test/declarative-migrate.test.ts 的既有 pattern)。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({
    enabled: [],
    hooks: { doAction: async () => undefined },
  }),
}));

import { validatePromptValues } from "../src/ext/dx/install-prompts";
import type { InstallPrompt } from "../src/ext/dx/install-prompts";
import {
  prepareExtensionSettingValues,
  setSettings,
  setExtensionSettingsRaw,
} from "../src/lib/settings";
import { isValidRegistrySources } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

describe("validatePromptValues (pure)", () => {
  const prompts: InstallPrompt[] = [
    { key: "apiKey", label: "API Key", type: "text", required: true, secret: true },
    { key: "webhookUrl", label: "Webhook URL", type: "text" },
    { key: "retries", label: "Retries", type: "number" },
    { key: "enabled", label: "Enabled", type: "boolean" },
  ];

  it("rejects an unknown key not declared in installPrompts", () => {
    const r = validatePromptValues(prompts, { apiKey: "x", bogus: "y" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("invalid_prompt_values");
      expect(r.fields).toEqual(["bogus"]);
    }
  });

  it("reports missing required prompts", () => {
    const r = validatePromptValues(prompts, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("missing_prompt_values");
      expect(r.fields).toEqual(["apiKey"]);
    }
  });

  it("treats an empty string for a required text prompt as missing", () => {
    const r = validatePromptValues(prompts, { apiKey: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("missing_prompt_values");
      expect(r.fields).toEqual(["apiKey"]);
    }
  });

  it("treats whitespace-only required text as missing", () => {
    const r = validatePromptValues(prompts, { apiKey: "   \n" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("missing_prompt_values");
      expect(r.fields).toEqual(["apiKey"]);
    }
  });

  it("rejects wrong types per prompt type", () => {
    const r = validatePromptValues(prompts, {
      apiKey: "secret-value",
      retries: "not-a-number",
      enabled: "yes",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("invalid_prompt_values");
      expect(r.fields.sort()).toEqual(["enabled", "retries"]);
    }
  });

  it("rejects non-finite numbers", () => {
    const r = validatePromptValues(prompts, {
      apiKey: "secret-value",
      retries: Infinity,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("invalid_prompt_values");
      expect(r.fields).toEqual(["retries"]);
    }
  });

  it("happy path: required satisfied, optional provided with correct types", () => {
    const r = validatePromptValues(prompts, {
      apiKey: "secret-value",
      webhookUrl: "https://example.com/hook",
      retries: 3,
      enabled: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.values).toEqual({
        apiKey: "secret-value",
        webhookUrl: "https://example.com/hook",
        retries: 3,
        enabled: true,
      });
    }
  });

  it("happy path: optional prompts may be omitted entirely", () => {
    const r = validatePromptValues(prompts, { apiKey: "secret-value" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.values).toEqual({ apiKey: "secret-value" });
    }
  });

  it("no prompts declared + no values → ok with empty values", () => {
    const r = validatePromptValues(undefined, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values).toEqual({});
  });
});

describe("registry source validation", () => {
  it("accepts HTTPS strings and source objects", () => {
    expect(
      isValidRegistrySources([
        "https://registry.example.com",
        { url: "https://private.example.com", token: "secret" },
      ]),
    ).toBe(true);
  });

  it("rejects malformed, non-array and insecure values", () => {
    expect(isValidRegistrySources("invalid")).toBe(false);
    expect(isValidRegistrySources(["https://"])).toBe(false);
    expect(isValidRegistrySources(["http://insecure.example.com"])).toBe(false);
    expect(isValidRegistrySources([{ url: "https://ok.example.com", token: 1 }])).toBe(
      false,
    );
  });
});

describe("setExtensionSettingsRaw (miniflare D1)", () => {
  beforeAll(async () => {
    await d1().exec(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
    );
  });

  it("stores a secret key encrypted (not plaintext) and a non-secret key as plain JSON", async () => {
    await setExtensionSettingsRaw(
      {
        "ext.demo.apiKey": "super-secret-value",
        "ext.demo.siteLabel": "My Demo Site",
      },
      new Set(["ext.demo.apiKey"]),
    );

    const secretRow = await d1()
      .prepare("SELECT value FROM settings WHERE key = ?1")
      .bind("ext.demo.apiKey")
      .first<{ value: string }>();
    expect(secretRow?.value).toBeDefined();
    // stored value must not be the plaintext JSON-encoded secret …
    expect(secretRow?.value).not.toBe(JSON.stringify("super-secret-value"));
    // … it must be JSON-encoded base64 ciphertext instead.
    const decoded = JSON.parse(secretRow!.value) as string;
    expect(decoded).not.toBe("super-secret-value");
    expect(() => atob(decoded)).not.toThrow();

    const plainRow = await d1()
      .prepare("SELECT value FROM settings WHERE key = ?1")
      .bind("ext.demo.siteLabel")
      .first<{ value: string }>();
    expect(plainRow?.value).toBe(JSON.stringify("My Demo Site"));
  });

  it("upserts (overwrites) an existing value on conflict", async () => {
    await setExtensionSettingsRaw({ "ext.demo.siteLabel": "First" }, new Set());
    await setExtensionSettingsRaw({ "ext.demo.siteLabel": "Second" }, new Set());

    const row = await d1()
      .prepare("SELECT value FROM settings WHERE key = ?1")
      .bind("ext.demo.siteLabel")
      .first<{ value: string }>();
    expect(row?.value).toBe(JSON.stringify("Second"));
  });
});

describe("prepareExtensionSettingValues", () => {
  it("encrypts non-empty secret defaults before an install batch", async () => {
    const prepared = await prepareExtensionSettingValues(
      { "ext.demo.apiKey": "bootstrap-secret" },
      new Set(["ext.demo.apiKey"]),
    );
    const stored = JSON.parse(prepared["ext.demo.apiKey"]) as string;
    expect(stored).not.toBe("bootstrap-secret");
    expect(() => atob(stored)).not.toThrow();
  });
});

describe("setSettings atomic preparation", () => {
  it("does not partially persist earlier entries when a later value cannot serialize", async () => {
    await d1()
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      )
      .bind("core.atomicProbe", JSON.stringify("old"), Date.now())
      .run();

    await expect(
      setSettings({
        "core.atomicProbe": "new",
        "core.unserializable": BigInt(1),
      }),
    ).rejects.toThrow(/not JSON serializable/);

    const row = await d1()
      .prepare("SELECT value FROM settings WHERE key = ?1")
      .bind("core.atomicProbe")
      .first<{ value: string }>();
    expect(row?.value).toBe(JSON.stringify("old"));
  });
});
