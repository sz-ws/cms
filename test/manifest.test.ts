import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/ext/dx/manifest";
import { unmetRequiredServices } from "../src/ext/service-requirements";
import { sanitizePublicCreateBody } from "../src/ext/dx/public-create";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";

const base = {
  kind: "declarative" as const,
  id: "contact-ext",
  name: "Contact",
  version: "1.0.0",
  coreApi: "^1.4.0",
};

describe("parseManifest", () => {
  it("omits forms gracefully (back-compat with existing manifests)", () => {
    const r = parseManifest(base);
    expect(r.ok).toBe(true);
  });

  it("rejects invalid setting defaults and duplicate select values", () => {
    expect(
      parseManifest({
        ...base,
        settings: [{ key: "count", label: "Count", type: "number", default: "3" }],
      }).ok,
    ).toBe(false);
    expect(
      parseManifest({
        ...base,
        coreApi: "^1.18.0",
        settings: [
          {
            key: "mode",
            label: "Mode",
            type: "select",
            default: "a",
            options: [
              { value: "a", label: "A" },
              { value: "a", label: "Again" },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it("allows a required setting to start unconfigured with an empty default", () => {
    expect(
      parseManifest({
        ...base,
        coreApi: "^1.18.0",
        settings: [
          {
            key: "apiKey",
            label: "API key",
            type: "text",
            required: true,
            default: "",
          },
        ],
      }).ok,
    ).toBe(true);
  });

  it("requires coreApi 1.18.0 when settings use required", () => {
    const result = parseManifest({
      ...base,
      settings: [
        {
          key: "apiKey",
          label: "API key",
          type: "text",
          required: true,
          default: "",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("1.18.0");
  });

  it("rejects options on non-select settings", () => {
    expect(
      parseManifest({
        ...base,
        settings: [
          {
            key: "label",
            label: "Label",
            type: "text",
            default: "",
            options: [{ value: "x", label: "X" }],
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects non-empty secret defaults", () => {
    expect(
      parseManifest({
        ...base,
        settings: [
          {
            key: "apiKey",
            label: "API key",
            type: "text",
            secret: true,
            default: "plaintext-secret",
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects duplicate nested fields and block names", () => {
    const result = parseManifest({
      ...base,
      contentTypes: [
        {
          name: "page",
          fields: [
            {
              key: "meta",
              type: "group",
              fields: [
                { key: "title", type: "text" },
                { key: "title", type: "text" },
              ],
            },
            {
              key: "body",
              type: "blocks",
              blocks: [
                { name: "hero", fields: [{ key: "title", type: "text" }] },
                {
                  name: "hero",
                  fields: [
                    { key: "copy", type: "text" },
                    { key: "copy", type: "text" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("duplicate nested field key");
    expect(result.error).toContain("duplicate block name");
    expect(result.error).toContain("duplicate block field key");
  });

  it("rejects duplicate names and broken content type references", () => {
    const result = parseManifest({
      ...base,
      contentTypes: [
        {
          name: "post",
          slugField: "missing",
          fields: [
            { key: "title", type: "text" },
            { key: "title", type: "text" },
          ],
        },
        { name: "post", fields: [{ key: "name", type: "text" }] },
      ],
      adminPages: [
        { slug: "", title: "Missing", view: "collection", contentType: "missing" },
      ],
      publicRoutes: [
        { pattern: "/missing", view: "list", contentType: "missing" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("duplicate content type name");
    expect(result.error).toContain("duplicate field key");
    expect(result.error).toContain("slugField");
    expect(result.error).toContain("adminPages");
    expect(result.error).toContain("publicRoutes");
  });

  it("rejects webhook secret settings that are absent or not secret", () => {
    const result = parseManifest({
      ...base,
      settings: [{ key: "signingKey", label: "Key", type: "text", default: "" }],
      on: {
        "content:created": [
          {
            action: "webhook",
            url: "https://example.com/hook",
            secretSetting: "signingKey",
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("must reference a secret setting");
  });

  it("rejects unknown declarative hook names", () => {
    expect(
      parseManifest({
        ...base,
        on: {
          "content:cretaed": [
            { action: "webhook", url: "https://example.com/hook" },
          ],
        },
      }).ok,
    ).toBe(false);
  });

  it("parses declarative contentType with public:true (anonymous POST enabled)", () => {
    const r = parseManifest({
      kind: "declarative",
      id: "contact",
      name: "Contact",
      version: "1.0.0",
      coreApi: "^1.3.0",
      description: "Declarative public contact form.",
      contentTypes: [
        {
          name: "submission",
          label: "Contact submissions",
          slugField: "email",
          public: true,
          fields: [
            { key: "name", type: "text", label: "姓名", required: true },
            { key: "email", type: "text", label: "Email", required: true },
            { key: "message", type: "text", label: "訊息", required: true },
          ],
        },
      ],
      adminPages: [
        {
          slug: "",
          title: "Contact submissions",
          view: "collection",
          contentType: "submission",
        },
      ],
      publicRoutes: [
        {
          pattern: "/contact",
          view: "form",
          contentType: "submission",
          success: { message: "收到你的訊息了" },
        },
      ],
      on: {
        "content:created": [
          {
            action: "webhook",
            url: "https://hooks.example.com/x",
            secretSetting: "webhookSecret",
          },
        ],
      },
      settings: [
        {
          key: "webhookSecret",
          label: "Webhook 密鑰",
          type: "text",
          default: "",
          secret: true,
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.contentTypes?.[0].public).toBe(true);
    expect(r.manifest?.contentTypes?.[0].fields).toHaveLength(3);
    expect(r.manifest?.contentTypes?.[0].slugField).toBe("email");
    expect(r.manifest?.publicRoutes?.[0]?.view).toBe("form");
    expect(r.manifest?.publicRoutes?.[0]?.success?.message).toBe("收到你的訊息了");
    expect(r.manifest?.on?.["content:created"]).toHaveLength(1);
  });

  it("sanitizes anonymous public create payload to declared fields only", () => {
    const ct: DeclarativeContentType = {
      name: "submission",
      public: true,
      fields: [
        { key: "name", type: "text", required: true },
        { key: "email", type: "text", required: true },
      ],
    };

    expect(
      sanitizePublicCreateBody(
        {
          name: "Ada",
          email: "ada@example.com",
          status: "published",
          slug: "chosen",
          extra: "ignore-me",
          _hp: "",
        },
        ct,
      ),
    ).toEqual({
      name: "Ada",
      email: "ada@example.com",
    });
  });
});

describe("parseManifest — marketplace metadata (1.5.0)", () => {
  it("accepts full metadata block", () => {
    const r = parseManifest({
      ...base,
      coreApi: "^1.5.0",
      author: {
        name: "Suko",
        url: "https://suko.tw",
        email: "hi@suko.tw",
      },
      homepage: "https://suko.tw/ext/contact",
      repository: "https://git.suko.tw/su/registry",
      license: "MIT",
      tags: ["contact", "form", "email"],
      category: "content",
      support: { url: "https://suko.tw/support" },
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.author?.name).toBe("Suko");
    expect(r.manifest?.license).toBe("MIT");
    expect(r.manifest?.category).toBe("content");
    expect(r.manifest?.tags).toHaveLength(3);
  });

  it("rejects more than 8 tags", () => {
    const r = parseManifest({
      ...base,
      tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown category and non-https urls", () => {
    expect(parseManifest({ ...base, category: "games" }).ok).toBe(false);
    expect(
      parseManifest({ ...base, homepage: "http://insecure.example.com" }).ok,
    ).toBe(false);
  });

  it("still rejects unknown top-level keys (strict schema)", () => {
    const r = parseManifest({ ...base, sponsor: "someone" });
    expect(r.ok).toBe(false);
  });
});

describe("parseManifest — capabilities (roadmap #17: install-time gate, not zod)", () => {
  it("rejects an empty-string capability", () => {
    const r = parseManifest({ ...base, capabilities: [""] });
    expect(r.ok).toBe(false);
  });

  it("rejects more than 16 capabilities", () => {
    const r = parseManifest({
      ...base,
      capabilities: Array.from({ length: 17 }, (_, i) => `feature-${i}`),
    });
    expect(r.ok).toBe(false);
  });

  it("accepts unknown capability names at the zod layer (gate is install-time)", () => {
    const r = parseManifest({
      ...base,
      capabilities: ["contents", "some-future-core-feature"],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.capabilities).toEqual([
      "contents",
      "some-future-core-feature",
    ]);
  });
});

describe("parseManifest — dashboardCards (roadmap #16)", () => {
  const withType = {
    ...base,
    coreApi: "^1.6.0",
    contentTypes: [
      { name: "post", label: "Posts", fields: [{ key: "title", type: "text" as const }] },
    ],
  };

  it("accepts stat + recent cards referencing a declared content type", () => {
    const r = parseManifest({
      ...withType,
      dashboardCards: [
        { kind: "stat", contentType: "post", title: "All posts" },
        { kind: "stat", contentType: "post", status: "published" },
        { kind: "recent", contentType: "post", limit: 3 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.dashboardCards).toHaveLength(3);
  });

  it("rejects a card whose contentType is not a declared contentTypes[].name (error names it)", () => {
    const r = parseManifest({
      ...withType,
      dashboardCards: [{ kind: "stat", contentType: "ghost" }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ghost/);
  });

  it("rejects `status` on a recent card", () => {
    const r = parseManifest({
      ...withType,
      dashboardCards: [{ kind: "recent", contentType: "post", status: "draft" }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/status/);
  });

  it("rejects `limit` on a stat card", () => {
    const r = parseManifest({
      ...withType,
      dashboardCards: [{ kind: "stat", contentType: "post", limit: 5 }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/limit/);
  });

  it("rejects more than 4 cards", () => {
    const r = parseManifest({
      ...withType,
      dashboardCards: Array.from({ length: 5 }, () => ({
        kind: "stat" as const,
        contentType: "post",
      })),
    });
    expect(r.ok).toBe(false);
  });
});

describe("parseManifest — installPrompts (must reference settings[].key)", () => {
  const settings = [
    { key: "apiKey", label: "API Key", type: "text" as const, default: "", secret: true },
    { key: "siteLabel", label: "Site Label", type: "text" as const, default: "" },
  ];

  it("rejects a prompt key with no matching settings[].key", () => {
    const r = parseManifest({
      ...base,
      settings,
      installPrompts: [
        { key: "doesNotExist", label: "Does not exist", type: "text" as const },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/doesNotExist/);
  });

  it("rejects a prompt whose secret flag disagrees with the referenced setting", () => {
    const r = parseManifest({
      ...base,
      settings,
      installPrompts: [
        // apiKey setting is secret:true; prompt omits secret (defaults false) → mismatch.
        { key: "apiKey", label: "API Key", type: "text" as const },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/secret/);
  });

  it("accepts a prompt that references a settings[].key with matching secret flag", () => {
    const r = parseManifest({
      ...base,
      settings,
      installPrompts: [
        { key: "apiKey", label: "API Key", type: "text" as const, secret: true, required: true },
        { key: "siteLabel", label: "Site Label", type: "text" as const },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.installPrompts).toHaveLength(2);
  });
});

describe("parseManifest — layout: \"stacked\" (1.7.0 vocabulary components)", () => {
  const withType = {
    ...base,
    coreApi: "^1.7.0",
    contentTypes: [
      { name: "post", label: "Posts", fields: [{ key: "title", type: "text" as const }] },
    ],
  };

  it("accepts layout:\"stacked\" on an adminPage", () => {
    const r = parseManifest({
      ...withType,
      adminPages: [
        {
          slug: "",
          title: "Posts",
          view: "collection",
          contentType: "post",
          layout: "stacked",
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.adminPages?.[0]?.layout).toBe("stacked");
  });

  it("accepts layout:\"stacked\" on a publicRoute (view: \"list\")", () => {
    const r = parseManifest({
      ...withType,
      publicRoutes: [
        {
          pattern: "/posts",
          view: "list",
          contentType: "post",
          layout: "stacked",
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.publicRoutes?.[0]?.layout).toBe("stacked");
  });

  it("still rejects an unknown layout value", () => {
    const r = parseManifest({
      ...withType,
      adminPages: [
        {
          slug: "",
          title: "Posts",
          view: "collection",
          contentType: "post",
          layout: "carousel",
        },
      ],
    });
    expect(r.ok).toBe(false);
  });
});

describe("parseManifest — publicRoute `stepped` (1.7.0, form view only)", () => {
  const withType = {
    ...base,
    coreApi: "^1.7.0",
    contentTypes: [
      {
        name: "submission",
        label: "Submissions",
        public: true,
        fields: [
          { key: "name", type: "text" as const, required: true },
          { key: "email", type: "text" as const, required: true },
        ],
      },
    ],
  };

  it("rejects `stepped` on view:\"list\"", () => {
    const r = parseManifest({
      ...withType,
      publicRoutes: [
        {
          pattern: "/submissions",
          view: "list",
          contentType: "submission",
          stepped: true,
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stepped/);
  });

  it("rejects `stepped` on view:\"detail\"", () => {
    const r = parseManifest({
      ...withType,
      publicRoutes: [
        {
          pattern: "/submissions/:slug",
          view: "detail",
          contentType: "submission",
          stepped: true,
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stepped/);
  });

  it("accepts `stepped` on view:\"form\"", () => {
    const r = parseManifest({
      ...withType,
      publicRoutes: [
        {
          pattern: "/contact",
          view: "form",
          contentType: "submission",
          stepped: true,
          success: { message: "收到你的訊息了" },
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.publicRoutes?.[0]?.stepped).toBe(true);
  });

  it("omitting `stepped` on a form route keeps back-compat (undefined, not false)", () => {
    const r = parseManifest({
      ...withType,
      publicRoutes: [
        { pattern: "/contact", view: "form", contentType: "submission" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.publicRoutes?.[0]?.stepped).toBeUndefined();
  });
});

describe("parseManifest — theme design tokens (1.8.0)", () => {
  const withTheme = (theme: unknown) => ({
    ...base,
    coreApi: "^1.8.0",
    theme,
  });

  it("accepts a valid theme (hex / oklch / rgb colors + px radius)", () => {
    const r = parseManifest(
      withTheme({
        accent: "#4f46e5",
        background: "oklch(98% 0 0)",
        muted: "rgb(100, 100, 100)",
        radius: "12px",
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.manifest?.theme?.accent).toBe("#4f46e5");
    expect(r.manifest?.theme?.radius).toBe("12px");
  });

  it("accepts a partial theme (all fields optional) and an empty theme", () => {
    expect(parseManifest(withTheme({ accent: "#000" })).ok).toBe(true);
    expect(parseManifest(withTheme({})).ok).toBe(true);
  });

  it("accepts rem radius", () => {
    expect(parseManifest(withTheme({ radius: "0.5rem" })).ok).toBe(true);
  });

  it('rejects a color carrying an injection payload (accent: "red;}")', () => {
    const r = parseManifest(withTheme({ accent: "red;}" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/accent/);
  });

  it('rejects a non-px/rem radius (radius: "calc(1px)")', () => {
    const r = parseManifest(withTheme({ radius: "calc(1px)" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/radius/);
  });

  it("rejects an unknown theme key (strict schema)", () => {
    const r = parseManifest(withTheme({ accent: "#000", gradient: "#fff" }));
    expect(r.ok).toBe(false);
  });

  it("rejects a color with braces/quotes even inside a function form", () => {
    expect(
      parseManifest(withTheme({ background: 'oklch(98% 0 0)";}' })).ok,
    ).toBe(false);
  });
});

// 1.8.0:stylesheet 欄位 —— v1 只收字面 "style.css"(不收任意路徑)。
describe("parseManifest stylesheet field", () => {
  it('accepts stylesheet: "style.css"', () => {
    const r = parseManifest({ ...base, stylesheet: "style.css" });
    expect(r.ok).toBe(true);
    expect(r.manifest?.stylesheet).toBe("style.css");
  });

  it("omits stylesheet gracefully (back-compat)", () => {
    const r = parseManifest(base);
    expect(r.ok).toBe(true);
    expect(r.manifest?.stylesheet).toBeUndefined();
  });

  it('rejects an arbitrary filename like "other.css"', () => {
    const r = parseManifest({ ...base, stylesheet: "other.css" });
    expect(r.ok).toBe(false);
  });

  it("rejects a path-y stylesheet value", () => {
    expect(parseManifest({ ...base, stylesheet: "../style.css" }).ok).toBe(false);
    expect(parseManifest({ ...base, stylesheet: "a/style.css" }).ok).toBe(false);
  });
});

// ---- requires(服務需求;與 capabilities 分軸)----

describe("manifest requires (service requirements)", () => {
  it("accepts valid service requirements", () => {
    const r = parseManifest({
      ...base,
      requires: [
        { capability: "email:send", reason: "寄送訂閱確認信" },
        { capability: "cron:tick", optional: true },
        { capability: "upload" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.requires).toEqual([
        { capability: "email:send", reason: "寄送訂閱確認信" },
        { capability: "cron:tick", optional: true },
        { capability: "upload" },
      ]);
    }
  });

  it("rejects invalid capability names and unknown keys", () => {
    expect(
      parseManifest({ ...base, requires: [{ capability: "Email:Send" }] }).ok,
    ).toBe(false);
    expect(
      parseManifest({ ...base, requires: [{ capability: "email:send:extra" }] }).ok,
    ).toBe(false);
    expect(
      parseManifest({
        ...base,
        requires: [{ capability: "email:send", version: "1.0.0" }],
      }).ok,
    ).toBe(false);
  });
});

describe("unmetRequiredServices", () => {
  it("returns only non-optional capabilities with no provider, deduped", () => {
    const available = ["upload", "content", "email:send"];
    expect(unmetRequiredServices(undefined, available)).toEqual([]);
    expect(
      unmetRequiredServices(
        [
          { capability: "email:send" },
          { capability: "cron:tick" },
          { capability: "cron:tick" },
          { capability: "pay:charge", optional: true },
        ],
        available,
      ),
    ).toEqual(["cron:tick"]);
  });
});

// ---- A: contentTypes[].notifyOnCreate (docs/spec-declarative-notify-schedule.md) ----

describe("parseManifest — notifyOnCreate (1.11.0)", () => {
  const withType = (ctExtra: Record<string, unknown>) => ({
    ...base,
    coreApi: "^1.11.0",
    contentTypes: [
      {
        name: "submission",
        public: true,
        fields: [{ key: "email", type: "text" }],
        ...ctExtra,
      },
    ],
  });

  it("accepts notifyOnCreate: true on a public content type", () => {
    const r = parseManifest(withType({ notifyOnCreate: true }));
    expect(r.ok).toBe(true);
    expect(r.manifest?.contentTypes?.[0].notifyOnCreate).toBe(true);
  });

  it("omitting notifyOnCreate stays valid (back-compat, undefined not false)", () => {
    const r = parseManifest(withType({}));
    expect(r.ok).toBe(true);
    expect(r.manifest?.contentTypes?.[0].notifyOnCreate).toBeUndefined();
  });

  it("rejects a non-boolean notifyOnCreate", () => {
    expect(parseManifest(withType({ notifyOnCreate: "yes" })).ok).toBe(false);
  });
});

// ---- B: 頂層 schedule[] (docs/spec-declarative-notify-schedule.md 測試 #5) ----

describe("parseManifest — schedule[] (1.11.0)", () => {
  const withSchedule = (schedule: unknown) => ({
    ...base,
    coreApi: "^1.11.0",
    contentTypes: [
      {
        name: "submission",
        fields: [{ key: "email", type: "text" }],
      },
    ],
    schedule,
  });

  const validItem = {
    id: "purge-old",
    every: 1440,
    action: { op: "deleteOlderThan", contentType: "submission", days: 90 },
  };

  it("accepts a well-formed schedule item", () => {
    const r = parseManifest(withSchedule([validItem]));
    expect(r.ok).toBe(true);
    expect(r.manifest?.schedule).toEqual([validItem]);
  });

  it("omitting schedule stays valid (back-compat)", () => {
    const r = parseManifest(withSchedule(undefined));
    expect(r.ok).toBe(true);
    expect(r.manifest?.schedule).toBeUndefined();
  });

  it("rejects duplicate ids within schedule[]", () => {
    const r = parseManifest(withSchedule([validItem, { ...validItem }]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/duplicate schedule id/);
  });

  it("rejects every: 0 (must be >= 1)", () => {
    const r = parseManifest(withSchedule([{ ...validItem, every: 0 }]));
    expect(r.ok).toBe(false);
  });

  it("rejects action.days: 0 (must be >= 1)", () => {
    const r = parseManifest(
      withSchedule([
        { ...validItem, action: { ...validItem.action, days: 0 } },
      ]),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown action op", () => {
    const r = parseManifest(
      withSchedule([
        {
          ...validItem,
          action: { op: "archiveOlderThan", contentType: "submission", days: 90 },
        },
      ]),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects extra keys on a schedule item (strict schema)", () => {
    const r = parseManifest(withSchedule([{ ...validItem, extra: true }]));
    expect(r.ok).toBe(false);
  });

  it("rejects extra keys on the action (strict schema)", () => {
    const r = parseManifest(
      withSchedule([
        { ...validItem, action: { ...validItem.action, extra: true } },
      ]),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects more than 8 schedule items", () => {
    const items = Array.from({ length: 9 }, (_, i) => ({
      ...validItem,
      id: `job-${i}`,
    }));
    expect(parseManifest(withSchedule(items)).ok).toBe(false);
  });

  it("accepts exactly 8 schedule items", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      ...validItem,
      id: `job-${i}`,
    }));
    expect(parseManifest(withSchedule(items)).ok).toBe(true);
  });

  it("rejects an invalid schedule id (uppercase / leading digit)", () => {
    expect(
      parseManifest(withSchedule([{ ...validItem, id: "Bad" }])).ok,
    ).toBe(false);
    expect(
      parseManifest(withSchedule([{ ...validItem, id: "1bad" }])).ok,
    ).toBe(false);
  });
});
