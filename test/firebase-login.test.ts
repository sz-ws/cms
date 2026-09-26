import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.54.0:Firebase 登入(src/lib/firebase-login.ts)binding-backed 測試(miniflare D1)。
// Google 的 securetoken JWKS 以 mock 的 global.fetch 提供,ID token 以測試內的 RSA key 簽。
// settings 以 in-memory map mock(同 oidc.test.ts)。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const settingsStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/settings", () => ({
  getSetting: async <T>(key: string, fallback?: T): Promise<T> =>
    (settingsStore.has(key) ? (settingsStore.get(key) as unknown as T) : (fallback as T)),
  extSetting: (extId: string, key: string): string => `ext.${extId}.${key}`,
}));

import { completeFirebaseLogin } from "../src/lib/firebase-login";
import { listLoginProviders, listUserIdentities, __clearOidcCaches } from "../src/lib/oidc";
import { FIREBASE_LOGIN_MANIFEST } from "./login-provider-manifest.test";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const PROVIDER = "firebase-login";
const PROJECT = "demo-shop-1234";
const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let keys: CryptoKeyPair;
let jwksDoc: { keys: JsonWebKey[] };

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlStr = (s: string): string => b64url(new TextEncoder().encode(s));

async function signToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    iat: now,
    exp: now + 3600,
    auth_time: now,
    sub: "firebase-uid-1",
    email: "buyer@test.com",
    email_verified: true,
    name: "Buyer",
    firebase: { sign_in_provider: "google.com", identities: {} },
    ...overrides,
  };
  const header = b64urlStr(JSON.stringify({ alg: "RS256", kid: "fb-1", typ: "JWT" }));
  const payload = b64urlStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keys.privateKey, data),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

async function seedUser(id: string, email: string, role: string, emailVerified = false): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at, email_verified_at) VALUES (?1, ?2, 'x', 'Name', ?3, ?4, ?5)",
    )
    .bind(id, email, role, Date.now(), emailVerified ? Date.now() : null)
    .run();
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  jwk.kid = "fb-1";
  jwk.alg = "RS256";
  jwksDoc = { keys: [jwk] };

  global.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === JWKS_URL) {
      return new Response(JSON.stringify(jwksDoc), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT, email_verified_at INTEGER);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS user_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_user_id TEXT NOT NULL, display TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
  );
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  __clearOidcCaches();
  settingsStore.clear();
  settingsStore.set(`ext.${PROVIDER}.apiKey`, "AIza-test");
  settingsStore.set(`ext.${PROVIDER}.authDomain`, `${PROJECT}.firebaseapp.com`);
  settingsStore.set(`ext.${PROVIDER}.projectId`, PROJECT);
  settingsStore.set("core.auth.oauthRegistration", "guest");

  await d1().exec("DELETE FROM users;");
  await d1().exec("DELETE FROM user_identities;");
  await d1().exec("DELETE FROM declarative_extensions;");
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, manifest, version, enabled, installed_at, updated_at) VALUES (?1, ?2, '1.0.0', 1, ?3, ?3)",
    )
    .bind(PROVIDER, JSON.stringify(FIREBASE_LOGIN_MANIFEST), Date.now())
    .run();
});

describe("listLoginProviders — firebase", () => {
  it("lists a configured Firebase provider with its web config", async () => {
    const list = await listLoginProviders();
    expect(list).toEqual([
      expect.objectContaining({
        id: PROVIDER,
        kind: "firebase",
        firebase: {
          apiKey: "AIza-test",
          authDomain: `${PROJECT}.firebaseapp.com`,
          projectId: PROJECT,
          signIn: "google.com",
        },
      }),
    ]);
  });

  it("omits it while any web config value is missing", async () => {
    settingsStore.delete(`ext.${PROVIDER}.projectId`);
    expect(await listLoginProviders()).toEqual([]);
  });
});

describe("completeFirebaseLogin", () => {
  it("creates a member for a fresh verified token and returns next", async () => {
    const outcome = await completeFirebaseLogin({
      providerId: PROVIDER,
      idToken: await signToken(),
      mode: "login",
      next: "/shop/checkout",
    });
    expect(outcome.kind).toBe("session");
    if (outcome.kind !== "session") return;
    expect(outcome.location).toBe("/shop/checkout");
    const row = await d1()
      .prepare("SELECT email, role FROM users WHERE id = ?1")
      .bind(outcome.userId)
      .first<{ email: string; role: string }>();
    expect(row).toEqual({ email: "buyer@test.com", role: "guest" });
    const ids = await listUserIdentities(outcome.userId);
    expect(ids[0]).toMatchObject({ provider: PROVIDER, display: "buyer@test.com" });
  });

  it("signs an existing member in by verified email", async () => {
    await seedUser("u-member", "buyer@test.com", "guest", true);
    const outcome = await completeFirebaseLogin({
      providerId: PROVIDER,
      idToken: await signToken(),
      mode: "login",
      next: "/",
    });
    expect(outcome).toEqual({ kind: "session", userId: "u-member", location: "/" });
  });

  it("refuses a token for another project", async () => {
    const outcome = await completeFirebaseLogin({
      providerId: PROVIDER,
      idToken: await signToken({ aud: "other-project-1" }),
      mode: "login",
    });
    expect(outcome).toEqual({ kind: "error", code: "oauth_failed" });
  });

  it("refuses a sign-in older than ten minutes", async () => {
    const outcome = await completeFirebaseLogin({
      providerId: PROVIDER,
      idToken: await signToken({ auth_time: Math.floor(Date.now() / 1000) - 20 * 60 }),
      mode: "login",
    });
    expect(outcome).toEqual({ kind: "error", code: "oauth_stale" });
  });

  it("refuses a sign-in method the manifest did not declare", async () => {
    const outcome = await completeFirebaseLogin({
      providerId: PROVIDER,
      idToken: await signToken({ firebase: { sign_in_provider: "password" } }),
      mode: "login",
    });
    expect(outcome).toEqual({ kind: "error", code: "oauth_failed" });
  });

  it("refuses a tampered token", async () => {
    const token = await signToken();
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64urlStr(JSON.stringify({ sub: "attacker" }))}.${s}`;
    const outcome = await completeFirebaseLogin({ providerId: PROVIDER, idToken: forged, mode: "login" });
    expect(outcome).toEqual({ kind: "error", code: "oauth_failed" });
  });

  it("reports provider_unavailable when the plugin is disabled", async () => {
    await d1().prepare("UPDATE declarative_extensions SET enabled = 0").run();
    const outcome = await completeFirebaseLogin({
      providerId: PROVIDER,
      idToken: await signToken(),
      mode: "login",
    });
    expect(outcome).toEqual({ kind: "error", code: "provider_unavailable" });
  });

  it("links the Firebase identity to the signed-in user", async () => {
    await seedUser("u-admin", "admin@test.com", "admin");
    const outcome = await completeFirebaseLogin({
      providerId: PROVIDER,
      idToken: await signToken({ email: "admin@gmail.test" }),
      mode: "link",
      userId: "u-admin",
    });
    expect(outcome).toEqual({ kind: "linked" });
    expect(await listUserIdentities("u-admin")).toHaveLength(1);
  });
});
