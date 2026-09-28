import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";

// AI 連線(MCP 授權)的純規則:回呼網址、登記、授權請求、PKCE、同意票、探索文件。
// 不碰 D1 的部分全在這裡;整個流程(登記 → 同意 → 換權杖 → MCP → 撤銷)在
// test/mcp-flow.test.ts。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => undefined,
}));

import {
  isAllowedRedirectUri,
  parseRegistration,
  redirectUriMatches,
  type McpClient,
} from "../src/lib/mcp/clients";
import { checkAuthorizeRequest, issueConsentTicket, readConsentTicket, appRedirectUrl, redirectDisplayHost } from "../src/lib/mcp/consent";
import { pkceChallenge, signTicket, verifyPkce, verifyTicket, isValidCodeChallenge } from "../src/lib/mcp/crypto";
import {
  authorizationServerMetadata,
  bearerChallenge,
  matchResource,
  protectedResourceMetadata,
} from "../src/lib/mcp/site";
import { isPublicPagePath } from "../src/lib/csp";

const ORIGIN = "https://shop.test";
const VERIFIER = "a".repeat(20) + "-._~" + "B".repeat(25);

describe("redirect URIs at registration", () => {
  it("accepts https, loopback http and private-use schemes", () => {
    expect(isAllowedRedirectUri("https://app.example/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:6274/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:33418/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:8080/cb")).toBe(true);
    expect(isAllowedRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("com.example.app:/oauth2redirect")).toBe(true);
  });

  it("refuses http off loopback, script schemes, fragments, credentials and whitespace", () => {
    for (const bad of [
      "http://app.example/callback",
      "http://localhost.evil.example/cb",
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "https://app.example/cb#frag",
      "https://user:pw@app.example/cb",
      "https://app.example/c b",
      "/relative/path",
      "",
      `https://app.example/${"x".repeat(2100)}`,
    ]) {
      expect(isAllowedRedirectUri(bad), bad).toBe(false);
    }
  });

  it("matches exactly, except the port of a loopback http URI (RFC 8252 §7.3)", () => {
    const registered = ["https://app.example/cb", "http://127.0.0.1/cb?x=1"];
    expect(redirectUriMatches(registered, "https://app.example/cb")).toBe(true);
    expect(redirectUriMatches(registered, "https://app.example/cb/")).toBe(false);
    expect(redirectUriMatches(registered, "https://app.example/cb?extra=1")).toBe(false);
    expect(redirectUriMatches(registered, "https://evil.example/cb")).toBe(false);
    expect(redirectUriMatches(registered, "http://127.0.0.1:51234/cb?x=1")).toBe(true);
    expect(redirectUriMatches(registered, "http://127.0.0.1:51234/other?x=1")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:51234/cb?x=1")).toBe(false);
  });
});

describe("dynamic client registration metadata", () => {
  it("defaults to client_secret_basic and cleans the name", () => {
    const parsed = parseRegistration({
      client_name: "  My\u0000   App  ",
      redirect_uris: ["https://app.example/cb"],
    });
    expect(parsed).toEqual({
      ok: true,
      value: { name: "My App", redirectUris: ["https://app.example/cb"], authMethod: "client_secret_basic" },
    });
  });

  it("accepts public clients", () => {
    const parsed = parseRegistration({
      redirect_uris: ["http://localhost:3000/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(parsed.ok && parsed.value.authMethod).toBe("none");
  });

  it("rejects bad metadata with the RFC 7591 error codes", () => {
    expect(parseRegistration({})).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(parseRegistration({ redirect_uris: ["http://evil.example/cb"] })).toMatchObject({
      ok: false,
      error: "invalid_redirect_uri",
    });
    expect(
      parseRegistration({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "private_key_jwt" }),
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(
      parseRegistration({ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] }),
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(parseRegistration({ redirect_uris: ["https://a.example/cb"], response_types: ["token"] })).toMatchObject({
      ok: false,
      error: "invalid_client_metadata",
    });
  });
});

describe("PKCE", () => {
  it("verifies S256 and rejects everything else", async () => {
    const challenge = await pkceChallenge(VERIFIER);
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(await verifyPkce(VERIFIER, challenge)).toBe(true);
    expect(await verifyPkce(VERIFIER + "x", challenge)).toBe(false);
    expect(await verifyPkce("short", challenge)).toBe(false);
    expect(await verifyPkce(undefined, challenge)).toBe(false);
    // plain 方法(verifier 當 challenge)不算。
    expect(await verifyPkce(VERIFIER, VERIFIER)).toBe(false);
  });
});

const CLIENT: McpClient = {
  id: "mcp_ci_test",
  name: "Test App",
  redirectUris: ["https://app.example/cb"],
  secretHash: null,
};

async function authorizeQuery(extra: Record<string, string | string[]> = {}) {
  return {
    response_type: "code",
    client_id: CLIENT.id,
    redirect_uri: "https://app.example/cb",
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    state: "s-123",
    resource: `${ORIGIN}/api/mcp`,
    ...extra,
  };
}

describe("authorization request", () => {
  it("accepts a well-formed request", async () => {
    const check = checkAuthorizeRequest(await authorizeQuery(), CLIENT, ORIGIN);
    expect(check).toMatchObject({
      ok: true,
      request: { clientId: CLIENT.id, redirectUri: "https://app.example/cb", state: "s-123", resource: `${ORIGIN}/api/mcp` },
    });
  });

  it("never redirects for an unknown client or an unregistered redirect URI", async () => {
    expect(checkAuthorizeRequest(await authorizeQuery(), null, ORIGIN)).toEqual({
      ok: false,
      kind: "page",
      reason: "unknown_client",
    });
    expect(
      checkAuthorizeRequest(await authorizeQuery({ redirect_uri: "https://evil.example/cb" }), CLIENT, ORIGIN),
    ).toMatchObject({ ok: false, kind: "page", reason: "bad_redirect_uri" });
    expect(
      checkAuthorizeRequest(await authorizeQuery({ redirect_uri: ["https://app.example/cb", "https://evil.example/cb"] }), CLIENT, ORIGIN),
    ).toMatchObject({ ok: false, kind: "page" });
  });

  it("sends other errors back to the app with the state", async () => {
    expect(
      checkAuthorizeRequest(await authorizeQuery({ code_challenge_method: "plain" }), CLIENT, ORIGIN),
    ).toMatchObject({ ok: false, kind: "redirect", error: "invalid_request", state: "s-123" });
    const noPkce = await authorizeQuery();
    delete (noPkce as Record<string, unknown>).code_challenge;
    expect(checkAuthorizeRequest(noPkce, CLIENT, ORIGIN)).toMatchObject({ kind: "redirect", error: "invalid_request" });
    expect(checkAuthorizeRequest(await authorizeQuery({ response_type: "token" }), CLIENT, ORIGIN)).toMatchObject({
      kind: "redirect",
      error: "unsupported_response_type",
    });
    expect(
      checkAuthorizeRequest(await authorizeQuery({ resource: "https://other.test/api/mcp" }), CLIENT, ORIGIN),
    ).toMatchObject({ kind: "redirect", error: "invalid_target" });
  });

  it("defaults the resource and accepts the site origin as the resource", async () => {
    const noResource = await authorizeQuery();
    delete (noResource as Record<string, unknown>).resource;
    expect(checkAuthorizeRequest(noResource, CLIENT, ORIGIN)).toMatchObject({
      ok: true,
      request: { resource: `${ORIGIN}/api/mcp` },
    });
    expect(matchResource(`${ORIGIN}/api/mcp/`, ORIGIN)).toBe(`${ORIGIN}/api/mcp`);
    expect(matchResource(ORIGIN, ORIGIN)).toBe(`${ORIGIN}/api/mcp`);
    expect(matchResource(`${ORIGIN}/api/content`, ORIGIN)).toBeNull();
  });

  it("builds the redirect back to the app, keeping its own query", () => {
    const url = appRedirectUrl("https://app.example/cb?keep=1", { code: "c", state: null, iss: ORIGIN });
    expect(url).toBe(`https://app.example/cb?keep=1&code=c&iss=${encodeURIComponent(ORIGIN)}`);
    expect(redirectDisplayHost("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
    expect(redirectDisplayHost("cursor://anysphere.cursor-mcp/oauth/callback")).toBe("cursor");
  });
});

describe("consent ticket", () => {
  it("round-trips only with the same session secret, before it expires", async () => {
    const check = checkAuthorizeRequest(await authorizeQuery(), CLIENT, ORIGIN);
    if (!check.ok) throw new Error("expected ok");
    const now = 1_000_000;
    const ticket = await issueConsentTicket(check.request, "u-admin", "session-secret", now);
    expect(await readConsentTicket(ticket, "session-secret", now + 1000)).toMatchObject({
      userId: "u-admin",
      clientId: CLIENT.id,
      redirectUri: "https://app.example/cb",
    });
    expect(await readConsentTicket(ticket, "another-session", now + 1000)).toBeNull();
    expect(await readConsentTicket(ticket, "session-secret", now + 11 * 60 * 1000)).toBeNull();
  });

  it("rejects a ticket whose body was changed", async () => {
    const ticket = await signTicket({ exp: Date.now() + 60_000 }, "k");
    const [body, mac] = ticket.split(".");
    const forged = `${body}A.${mac}`;
    expect(await verifyTicket(forged, "k", Date.now())).toBeNull();
    expect(await verifyTicket("not-a-ticket", "k", Date.now())).toBeNull();
    expect(await verifyTicket(ticket, "", Date.now())).toBeNull();
  });
});

describe("discovery documents", () => {
  it("advertise one origin, S256 and the MCP resource", () => {
    expect(protectedResourceMetadata(ORIGIN, "Shop")).toEqual({
      resource: `${ORIGIN}/api/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: ["read", "write"],
      bearer_methods_supported: ["header"],
      resource_name: "Shop",
    });
    const as = authorizationServerMetadata(ORIGIN);
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("points 401s at the resource metadata", () => {
    expect(bearerChallenge(ORIGIN)).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    );
    expect(bearerChallenge(ORIGIN, "invalid_token")).toContain('error="invalid_token"');
  });

  it("the consent page gets the enforced public CSP (frame-ancestors 'none')", () => {
    expect(isPublicPagePath("/oauth/authorize")).toBe(true);
  });
});
