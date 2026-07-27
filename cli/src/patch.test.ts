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

// ---- CORE_API 1.25.0:宣告式 extension 的程式碼強化層 ----
//
// 強化層**不是** Extension:它在 module load 時把自訂元件登記進 overrides registry,
// 而 extension 本體是宣告式的、住在 DB 裡。所以接法是純 side-effect import。

describe("patchRegistryContent — enhancement mode", () => {
  const file =
    HEADER + `export const registry: Extension[] = [cron];\n`;

  it("只加 side-effect import,不碰 registry 陣列", () => {
    const r = patchRegistryContent(file, "catalog", "enhancement");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.importAdded).toBe(true);
    expect(r.arrayAdded).toBe(false);
    expect(r.content).toContain(`import "./catalog";`);
    // 陣列原樣不動 —— 把強化層加進去會讓 core 拿到一個沒有 id/version 的東西
    expect(r.content).toContain(`export const registry: Extension[] = [cron];`);
    expect(r.content).not.toContain("catalog]");
    expect(r.content).not.toContain(", catalog");
  });

  it("不產生具名 import(那會是 undefined,build 才炸)", () => {
    const r = patchRegistryContent(file, "catalog", "enhancement");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).not.toContain(`import { catalog }`);
  });

  it("重跑不會重複插入", () => {
    const once = patchRegistryContent(file, "catalog", "enhancement");
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = patchRegistryContent(once.content, "catalog", "enhancement");
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.alreadyUpToDate).toBe(true);
    expect(twice.content).toBe(once.content);
    expect(twice.content.match(/import "\.\/catalog";/g)).toHaveLength(1);
  });

  it("registry 陣列格式認不出來也照樣成功 —— 強化層根本不需要它", () => {
    const noArray = HEADER + `const registry = new Map();\n`;
    const r = patchRegistryContent(noArray, "catalog", "enhancement");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain(`import "./catalog";`);
  });

  it("預設仍是 extension 模式(既有呼叫端行為不變)", () => {
    const r = patchRegistryContent(file, "posts");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain(`import { posts } from "./posts";`);
    expect(r.arrayAdded).toBe(true);
  });

  it("同一個 id 兩種模式的 import 行不同,不會互相誤判為已存在", () => {
    const asExt = patchRegistryContent(file, "catalog", "extension");
    expect(asExt.ok).toBe(true);
    if (!asExt.ok) return;
    // 已經以 extension 形式接過,再以 enhancement 形式接 → 仍會加 side-effect import。
    // 這是刻意的:兩者語意不同,靜默略過會讓人以為裝好了。
    const asEnh = patchRegistryContent(asExt.content, "catalog", "enhancement");
    expect(asEnh.ok).toBe(true);
    if (!asEnh.ok) return;
    expect(asEnh.importAdded).toBe(true);
  });
});
