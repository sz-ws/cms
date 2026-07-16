import { describe, it, expect } from "vitest";
import { validateStylesheet } from "../src/ext/dx/stylesheet-guard";

// 1.8.0 stylesheet guard 是安全閘門 —— 這批測試即「哪些 CSS 可注入 extension public
// 頁面」的規格。happy path 要確保正當 CSS 通過;rejection 逐一釘住每個危險向量。

describe("validateStylesheet — happy path", () => {
  it("accepts plain classes and element selectors", () => {
    const css = `.card { color: #333; padding: 1rem; }\nh1 { font-weight: 700; }`;
    expect(validateStylesheet(css)).toEqual({ ok: true });
  });

  it("accepts media queries", () => {
    const css = `@media (min-width: 640px) { .grid { display: grid; } }`;
    expect(validateStylesheet(css)).toEqual({ ok: true });
  });

  it("accepts nested selectors (CSS nesting)", () => {
    const css = `.menu { color: blue; & .item { color: red; } }`;
    expect(validateStylesheet(css)).toEqual({ ok: true });
  });

  it("accepts data:image/ url()", () => {
    const css = `.logo { background: url(data:image/png;base64,iVBORw0KGgo=); }`;
    expect(validateStylesheet(css)).toEqual({ ok: true });
  });

  it("accepts same-site absolute and relative url()", () => {
    expect(validateStylesheet(`.a { background: url(/assets/bg.png); }`)).toEqual({
      ok: true,
    });
    expect(validateStylesheet(`.b { background: url("images/hero.jpg"); }`)).toEqual(
      { ok: true },
    );
  });

  it("accepts legitimate CSS comments", () => {
    const css = `/* header styles */\n.header { display: flex; }`;
    expect(validateStylesheet(css)).toEqual({ ok: true });
  });
});

describe("validateStylesheet — forbidden tokens", () => {
  const denied: Array<[string, string]> = [
    ["@import", `@import url("/other.css");`],
    ["@charset", `@charset "utf-8"; .a { color: red; }`],
    ["@namespace", `@namespace svg url(http://www.w3.org/2000/svg);`],
    ["expression(", `.a { width: expression(alert(1)); }`],
    ["expression( with space", `.a { width: expression (alert(1)); }`],
    ["behavior:", `.a { behavior: url(x.htc); }`],
    ["behavior : with space", `.a { behavior : url(x.htc); }`],
    ["-moz-binding", `.a { -moz-binding: url(x.xml#e); }`],
    ["javascript:", `.a { background: url(javascript:alert(1)); }`],
  ];

  for (const [name, css] of denied) {
    it(`rejects ${name}`, () => {
      const r = validateStylesheet(css);
      expect(r.ok).toBe(false);
    });
  }

  it("rejects comment-obfuscated @im/**/port", () => {
    const r = validateStylesheet(`@im/**/port url("/x.css");`);
    expect(r.ok).toBe(false);
  });

  it("rejects @import regardless of case", () => {
    expect(validateStylesheet(`@IMPORT url("/x.css");`).ok).toBe(false);
  });
});

describe("validateStylesheet — style-tag breakout", () => {
  it("rejects </style> breakout", () => {
    const r = validateStylesheet(`.a { color: red; } </style><script>alert(1)</script>`);
    expect(r.ok).toBe(false);
  });

  it("rejects HTML comment breakout", () => {
    const r = validateStylesheet(`.a { color: red; } <!-- x -->`);
    expect(r.ok).toBe(false);
  });
});

describe("validateStylesheet — url() exfiltration channels", () => {
  const badUrls = [
    `.a { background: url(https://evil.com/x.png); }`,
    `.a { background: url("http://evil.com/x.png"); }`,
    `.a { background: url(//evil.com/x.png); }`, // protocol-relative
    `.a { background: url(blob:https://x/y); }`,
    `.a { background: url(data:text/html,<b>x</b>); }`, // data: but not image
  ];
  for (const css of badUrls) {
    it(`rejects ${css}`, () => {
      expect(validateStylesheet(css).ok).toBe(false);
    });
  }
});

describe("validateStylesheet — structural / size / bytes", () => {
  it("rejects unbalanced closing brace", () => {
    expect(validateStylesheet(`.a { color: red; } }`).ok).toBe(false);
  });

  it("rejects unbalanced opening brace", () => {
    expect(validateStylesheet(`.a { color: red;`).ok).toBe(false);
  });

  it("rejects stylesheet over 64KB", () => {
    // 每條 rule 都合法,但整體超過 64KB。
    const oneRule = `.x { color: #000; }\n`;
    const big = oneRule.repeat(Math.ceil((64 * 1024) / oneRule.length) + 10);
    expect(validateStylesheet(big).ok).toBe(false);
  });

  it("accepts stylesheet just under 64KB", () => {
    const oneRule = `.x { color: #000; }\n`;
    const near = oneRule.repeat(Math.floor((60 * 1024) / oneRule.length));
    expect(validateStylesheet(near)).toEqual({ ok: true });
  });

  it("rejects control bytes (NUL)", () => {
    expect(validateStylesheet(".a { color: red; }\x00").ok).toBe(false);
  });

  it("rejects other control bytes (vertical tab / form feed)", () => {
    expect(validateStylesheet(".a {\x0B color: red; }").ok).toBe(false);
    expect(validateStylesheet(".a {\x0C color: red; }").ok).toBe(false);
  });

  it("allows whitespace control chars (tab, newline, carriage return)", () => {
    expect(validateStylesheet(".a {\n\t color: red;\r\n }")).toEqual({ ok: true });
  });

  it("rejects U+FFFD replacement char (invalid UTF-8 marker)", () => {
    expect(validateStylesheet(".a { color: red; }�").ok).toBe(false);
  });
});
