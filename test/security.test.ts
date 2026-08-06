import { describe, expect, it } from "vitest";
import { assertSameOrigin, OriginError } from "../src/lib/security";

function request(origin: string | null, headers: Record<string, string> = {}) {
  const requestHeaders = new Headers(headers);
  if (origin !== null) requestHeaders.set("origin", origin);
  return new Request("http://localhost:3001/api/auth/login", {
    method: "POST",
    headers: requestHeaders,
  });
}

describe("assertSameOrigin", () => {
  it("accepts a direct same-origin request", () => {
    expect(() =>
      assertSameOrigin(request("http://localhost:3001")),
    ).not.toThrow();
  });

  it("accepts the public origin reconstructed by a reverse proxy", () => {
    expect(() =>
      assertSameOrigin(
        request("https://3001.okuso.uk", {
          host: "localhost:3001",
          "x-forwarded-host": "3001.okuso.uk",
          "x-forwarded-proto": "https",
        }),
      ),
    ).not.toThrow();
  });

  it("uses Host when the proxy only forwards the protocol", () => {
    expect(() =>
      assertSameOrigin(
        request("https://3001.okuso.uk", {
          host: "3001.okuso.uk",
          "x-forwarded-proto": "https",
        }),
      ),
    ).not.toThrow();
  });

  it("still rejects missing and foreign origins", () => {
    expect(() => assertSameOrigin(request(null))).toThrow(OriginError);
    expect(() =>
      assertSameOrigin(
        request("https://evil.example", {
          host: "3001.okuso.uk",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toThrow(OriginError);
  });
});
