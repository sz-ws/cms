import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/ext/dx/manifest";

// spec-login-providers.md §4/§8/§9:loginProvider manifest 表面驗證 + google/line
// fixtures(既有慣例:測試用 manifest inline 於測試檔)。

// ---- fixtures(§8;同步於 su-registry/registry 的 extensions/<id>/manifest.json)----

const GOOGLE_SVG =
  '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.8 6c1.9-5.6 7.1-9.8 13.7-9.8z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.1-3.8 6.5-9.5 6.5-16z"/><path fill="#FBBC05" d="M10.3 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.3.8-4.7l-7.8-6C.9 16.5 0 20.1 0 24s.9 7.5 2.5 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.1-5.5c-2 1.3-4.6 2.1-8.1 2.1-6.6 0-11.8-4.2-13.7-9.8l-7.8 6C6.4 42.6 14.6 48 24 48z"/></svg>';

export const GOOGLE_LOGIN_MANIFEST = {
  kind: "declarative" as const,
  id: "google-login",
  name: "Google Login",
  version: "1.0.0",
  coreApi: "^1.16.0",
  description: "Sign in with Google (OIDC).",
  loginProvider: {
    issuer: "https://accounts.google.com",
    button: {
      label: "使用 Google 繼續",
      svg: GOOGLE_SVG,
      background: "#ffffff",
      foreground: "#1f1f1f",
    },
  },
  settings: [
    { key: "clientId", label: "Client ID", type: "text" as const, default: "" },
    {
      key: "clientSecret",
      label: "Client Secret",
      type: "text" as const,
      secret: true,
      default: "",
    },
  ],
};

const LINE_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.3 7.9.3.1.7.2.8.5.1.3.1.7 0 1l-.1.8c0 .2-.2.9.8.5s5.4-3.2 7.4-5.5c1.4-1.5 2-3 2-4.7C22 6.6 17.5 3 12 3z"/></svg>';

export const LINE_LOGIN_MANIFEST = {
  kind: "declarative" as const,
  id: "line-login",
  name: "LINE Login",
  version: "1.0.0",
  coreApi: "^1.16.0",
  description: "Sign in with LINE (OIDC).",
  loginProvider: {
    issuer: "https://access.line.me",
    scopes: ["openid", "profile", "email"],
    button: {
      label: "使用 LINE 繼續",
      svg: LINE_SVG,
      background: "#06C755",
      foreground: "#ffffff",
    },
  },
  settings: [
    { key: "clientId", label: "Channel ID", type: "text" as const, default: "" },
    {
      key: "clientSecret",
      label: "Channel secret",
      type: "text" as const,
      secret: true,
      default: "",
    },
  ],
};

describe("loginProvider manifest — accepts", () => {
  it("the google-login fixture", () => {
    const r = parseManifest(GOOGLE_LOGIN_MANIFEST);
    expect(r.ok).toBe(true);
    expect(r.manifest?.loginProvider?.issuer).toBe("https://accounts.google.com");
    expect(r.manifest?.loginProvider?.button.label).toBe("使用 Google 繼續");
  });

  it("the line-login fixture (explicit scopes)", () => {
    const r = parseManifest(LINE_LOGIN_MANIFEST);
    expect(r.ok).toBe(true);
    expect(r.manifest?.loginProvider?.scopes).toEqual(["openid", "profile", "email"]);
  });

  it("a minimal loginProvider (label only, no svg/colors)", () => {
    const r = parseManifest({
      ...GOOGLE_LOGIN_MANIFEST,
      loginProvider: {
        issuer: "https://accounts.google.com",
        button: { label: "Google" },
      },
    });
    expect(r.ok).toBe(true);
  });
});

describe("loginProvider manifest — rejects", () => {
  function err(loginProvider: unknown): string {
    const r = parseManifest({ ...GOOGLE_LOGIN_MANIFEST, loginProvider });
    return r.ok ? "" : (r.error ?? "");
  }

  it("a non-https issuer", () => {
    expect(
      err({ issuer: "http://accounts.google.com", button: { label: "Google" } }),
    ).toMatch(/issuer.*https/i);
  });

  it("an svg with an on*= handler (svg-guard)", () => {
    expect(
      err({
        issuer: "https://accounts.google.com",
        button: { label: "Google", svg: '<svg onload="x()"><path d="M0 0"/></svg>' },
      }),
    ).toMatch(/button\.svg/i);
  });

  it("an svg with a <script> tag (svg-guard)", () => {
    expect(
      err({
        issuer: "https://accounts.google.com",
        button: { label: "Google", svg: "<svg><script>x()</script></svg>" },
      }),
    ).toMatch(/button\.svg/i);
  });

  it("an svg with a <foreignObject> (svg-guard)", () => {
    expect(
      err({
        issuer: "https://accounts.google.com",
        button: {
          label: "Google",
          svg: "<svg><foreignObject><b/></foreignObject></svg>",
        },
      }),
    ).toMatch(/button\.svg/i);
  });

  it("an unknown key (strict)", () => {
    expect(
      err({
        issuer: "https://accounts.google.com",
        button: { label: "Google" },
        extra: true,
      }),
    ).not.toBe("");
  });

  it("a too-long label", () => {
    expect(
      err({
        issuer: "https://accounts.google.com",
        button: { label: "x".repeat(41) },
      }),
    ).not.toBe("");
  });
});
