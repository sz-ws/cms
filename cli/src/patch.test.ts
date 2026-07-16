import { describe, it, expect } from "vitest";
import { camelCaseId, patchRegistryContent } from "./patch.js";

const HEADER = `import type { Extension } from "@/ext/types";\n`;

describe("camelCaseId", () => {
  it("leaves single-word ids untouched", () => {
    expect(camelCaseId("cron")).toBe("cron");
    expect(camelCaseId("newebpay")).toBe("newebpay");
  });
  it("camelCases hyphenated ids", () => {
    expect(camelCaseId("ai-smoke-test")).toBe("aiSmokeTest");
    expect(camelCaseId("my-cool-2fa")).toBe("myCool2fa");
  });
});

describe("patchRegistryContent — empty array", () => {
  const file =
    HEADER + `export const registry: Extension[] = [];\n`;
  it("adds import + array entry", () => {
    const r = patchRegistryContent(file, "posts");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.importAdded).toBe(true);
    expect(r.arrayAdded).toBe(true);
    expect(r.alreadyUpToDate).toBe(false);
    expect(r.content).toContain(`import { posts } from "./posts";`);
    expect(r.content).toContain(`export const registry: Extension[] = [posts];`);
  });
});

describe("patchRegistryContent — non-empty array", () => {
  const file =
    HEADER +
    `import { cron } from "./cron";\n` +
    `export const registry: Extension[] = [cron];\n`;
  it("appends after last import and to array tail", () => {
    const r = patchRegistryContent(file, "newebpay");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain(`import { newebpay } from "./newebpay";`);
    expect(r.content).toContain(
      `export const registry: Extension[] = [cron, newebpay];`,
    );
    // import 插在最後一個 import 之後(cron import 之後)。
    const importIdx = r.content.indexOf(`import { newebpay }`);
    const cronIdx = r.content.indexOf(`import { cron }`);
    expect(importIdx).toBeGreaterThan(cronIdx);
  });
});

describe("patchRegistryContent — anchors after side-effect imports", () => {
  const file =
    HEADER +
    `import { cron } from "./cron";\n` +
    `import "./gallery-enhance";\n` +
    `import "./blog/layout";\n` +
    `export const registry: Extension[] = [cron];\n`;
  it("inserts import after the LAST import (a side-effect one), never reorders", () => {
    const r = patchRegistryContent(file, "newebpay");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = r.content.split("\n");
    const blogIdx = lines.findIndex((l) => l.includes(`"./blog/layout"`));
    const newIdx = lines.findIndex((l) => l.includes(`import { newebpay }`));
    expect(newIdx).toBe(blogIdx + 1);
    // 既有行順序不變。
    expect(r.content.indexOf(`"./gallery-enhance"`)).toBeGreaterThan(
      r.content.indexOf(`import { cron }`),
    );
  });
});

describe("patchRegistryContent — idempotent", () => {
  const file =
    HEADER +
    `import { cron } from "./cron";\n` +
    `export const registry: Extension[] = [cron];\n`;
  it("does nothing when both import and array entry exist", () => {
    const r = patchRegistryContent(file, "cron");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.importAdded).toBe(false);
    expect(r.arrayAdded).toBe(false);
    expect(r.alreadyUpToDate).toBe(true);
    expect(r.content).toBe(file);
  });
});

describe("patchRegistryContent — partial states", () => {
  it("import present but not in array → only patches array", () => {
    const file =
      HEADER +
      `import { cron } from "./cron";\n` +
      `export const registry: Extension[] = [];\n`;
    const r = patchRegistryContent(file, "cron");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.importAdded).toBe(false);
    expect(r.arrayAdded).toBe(true);
    expect(r.content).toContain(`= [cron];`);
    // 沒有重複 import。
    expect(r.content.match(/import \{ cron \}/g)?.length).toBe(1);
  });
  it("array entry present but no import → only patches import", () => {
    const file =
      HEADER + `export const registry: Extension[] = [cron];\n`;
    const r = patchRegistryContent(file, "cron");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.importAdded).toBe(true);
    expect(r.arrayAdded).toBe(false);
  });
});

describe("patchRegistryContent — word-boundary array check", () => {
  it("does not treat 'pay' as present just because 'newebpay' is", () => {
    const file =
      HEADER +
      `import { newebpay } from "./newebpay";\n` +
      `import { pay } from "./pay";\n` +
      `export const registry: Extension[] = [newebpay];\n`;
    const r = patchRegistryContent(file, "pay");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.arrayAdded).toBe(true);
    expect(r.content).toContain(`= [newebpay, pay];`);
  });
});

describe("patchRegistryContent — broken format", () => {
  it("no registry array → no-array failure with hints", () => {
    const file = HEADER + `import { cron } from "./cron";\n`;
    const r = patchRegistryContent(file, "posts");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-array");
    expect(r.importLine).toBe(`import { posts } from "./posts";`);
    expect(r.ident).toBe("posts");
  });
  it("no imports at all → no-imports failure", () => {
    const file = `const x = 1;\n`;
    const r = patchRegistryContent(file, "posts");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-imports");
  });
});
