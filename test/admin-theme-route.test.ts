import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

const session = vi.hoisted(() => ({ role: "admin" as string | null }));
vi.mock("@/lib/cf", () => ({ getEnv: () => env, getDB: () => (env as { DB: unknown }).DB }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const rt = { enabled: [], all: [], hooks: new HookBus() };
  return { getExtRuntime: async () => rt };
});
vi.mock("@/lib/auth", () => ({
  requireAuth: async (role: string) => {
    if (!session.role) throw { status: 401 };
    if (role === "admin" && session.role !== "admin") throw { status: 403 };
    return { role: session.role };
  },
  authErrorResponse: (e: { status?: number }) => e?.status ? Response.json({ error: "auth" }, { status: e.status }) : null,
}));
import { GET, PUT } from "../src/app/api/admin-theme/route";
import { PUT as settingsPUT } from "../src/app/api/settings/route";
import { ADMIN_THEME_PRESETS } from "../src/lib/admin-theme";
import { getSetting, setSettings, invalidateSettingsCache } from "../src/lib/settings";

function request(body: unknown, origin = "https://cms.test") {
  return new Request("https://cms.test/api/admin-theme", { method: "PUT", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
}
beforeAll(async () => { await (env as { DB: D1Database }).DB.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);"); });
beforeEach(async () => {
  session.role = "admin";
  await (env as { DB: D1Database }).DB.exec("DELETE FROM settings;");
  invalidateSettingsCache();
});
describe("admin style persistence and access", () => {
  it("persists preset and accent together in real D1 and returns them after a new read", async () => {
    const appearance = ADMIN_THEME_PRESETS[1].appearance;
    expect((await PUT(request(appearance))).status).toBe(200);
    invalidateSettingsCache();
    expect(await getSetting("core.adminTheme")).toEqual(appearance.theme);
    expect(await getSetting("core.adminAccent")).toBe(appearance.accent);
    const response = await GET();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(appearance);
  });
  it("continues to honor old accent writes", async () => {
    await PUT(request(ADMIN_THEME_PRESETS[1].appearance));
    await setSettings({ "core.adminAccent": "#aabbcc" });
    expect((await (await GET()).json()).accent).toBe("#aabbcc");
  });
  it.each([null, "guest", "editor"])("role %s cannot change the site theme", async (role) => {
    session.role = role;
    expect((await PUT(request(ADMIN_THEME_PRESETS[0].appearance))).status).toBe(role ? 403 : 401);
    expect(await getSetting("core.adminTheme", null)).toBeNull();
    expect((await GET()).status).toBe(role ? 200 : 401);
  });
  it("rejects cross-origin, invalid JSON and unsafe themes without changing D1", async () => {
    const original = ADMIN_THEME_PRESETS[0].appearance;
    await PUT(request(original));
    expect((await PUT(request(ADMIN_THEME_PRESETS[1].appearance, "https://other.test"))).status).toBe(403);
    expect((await PUT(request({ ...original, theme: { ...original.theme, surface: "#000000" } }))).status).toBe(400);
    expect((await PUT(new Request("https://cms.test/api/admin-theme", { method: "PUT", headers: { Origin: "https://cms.test" }, body: "{" }))).status).toBe(400);
    expect(await (await GET()).json()).toEqual(original);
  });
  it("the generic settings API cannot bypass theme validation", async () => {
    const response = await settingsPUT(request({ entries: { "core.adminTheme": { ...ADMIN_THEME_PRESETS[0].appearance.theme, ink: "#ffffff" } } }));
    expect(response.status).toBe(400);
    expect(await getSetting("core.adminTheme", null)).toBeNull();
  });
});
