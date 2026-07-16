import { describe, it, expect } from "vitest";
import { validateSvg } from "../src/ext/dx/svg-guard";

// spec-login-providers.md §4 + §9:svg-guard allowlist 單元測試(純函式,無 bindings)。

const OK_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l3 7h7l-6 4 2 7-6-4-6 4 2-7-6-4h7z" fill="#EA4335"/></svg>';

describe("validateSvg — accepts", () => {
  it("a plain allowlisted icon", () => {
    expect(validateSvg(OK_SVG).ok).toBe(true);
  });

  it("gradients + defs + stops (allowlisted structural tags)", () => {
    const svg =
      '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs><circle cx="12" cy="12" r="10" fill="url(#g)"/></svg>';
    expect(validateSvg(svg).ok).toBe(true);
  });

  it("a comment that does not enable a bypass", () => {
    const svg = '<svg><!-- brand icon --><path d="M0 0h1v1H0z"/></svg>';
    expect(validateSvg(svg).ok).toBe(true);
  });
});

describe("validateSvg — rejects", () => {
  function reason(svg: string): string {
    const r = validateSvg(svg);
    return r.ok ? "" : r.reason;
  }

  it("a <script> tag", () => {
    expect(reason('<svg><script>alert(1)</script></svg>')).toMatch(/script/i);
  });

  it("an on*= event handler", () => {
    expect(reason('<svg onload="alert(1)"><path d="M0 0"/></svg>')).toMatch(
      /on\*=|event handler/i,
    );
  });

  it("a <foreignObject>", () => {
    expect(reason('<svg><foreignObject><div/></foreignObject></svg>')).toMatch(
      /foreignobject|forbidden tag/i,
    );
  });

  it("an <image> tag", () => {
    expect(reason('<svg><image href="x.png"/></svg>')).toMatch(/image|href|forbidden/i);
  });

  it("a <use> tag", () => {
    expect(reason('<svg><use href="#x"/></svg>')).toMatch(/use|href|forbidden/i);
  });

  it("a <style> tag", () => {
    expect(reason('<svg><style>*{fill:red}</style></svg>')).toMatch(/style|forbidden tag/i);
  });

  it("an <animate> tag", () => {
    expect(reason('<svg><animate attributeName="x"/></svg>')).toMatch(/animate|forbidden tag/i);
  });

  it("a javascript: scheme", () => {
    expect(reason('<svg><path fill="javascript:alert(1)"/></svg>')).toMatch(/javascript:/i);
  });

  it("href / xlink:href", () => {
    expect(reason('<svg><path xlink:href="#x"/></svg>')).toMatch(/href/i);
  });

  it("an external URL reference", () => {
    expect(reason('<svg><path fill="url(https://evil.example/x)"/></svg>')).toMatch(
      /external url/i,
    );
  });

  it("a comment-obfuscated script tag", () => {
    // 註解移除後 `<scr` + `ipt>` 黏回 `<script>` → 命中 tag/script 檢查。
    expect(reason('<svg><scr<!-- x -->ipt>alert(1)</script></svg>')).not.toBe("");
  });

  it("input without an <svg> root", () => {
    expect(reason('<path d="M0 0"/>')).toMatch(/svg.*root/i);
  });
});
