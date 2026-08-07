import { describe, it, expect } from "vitest";

// docs/spec-admin-agent.md Phase D:面板裡另外兩組純函式的單元測試 ——
// 斜線工具選單(tools.ts)與確認卡的參數表(args.ts)。
//
// 兩者的共通點是「錯了不會壞掉,只會誤導人」:選單把不相干的 tool 排到第一位,
// 或參數表把一段巢狀物件靜默截掉尾巴 —— 畫面都還在,只是 admin 據以按下〔確認執行〕
// 的資訊是錯的。這種錯誤用眼睛看不出來,只能用測試釘。

import {
  ARG_MAX_DEPTH,
  ARG_MAX_ROWS,
  ARG_VALUE_MAX_CHARS,
  flattenArgs,
} from "../src/components/admin/agent/args";
import {
  applySlashSelection,
  matchTools,
  readSlashQuery,
  toolBlurb,
  toolLeaf,
  toolNamespace,
} from "../src/components/admin/agent/tools";
import type { AgentToolSummary } from "../src/components/admin/agent/tools";

const TOOLS: AgentToolSummary[] = [
  {
    name: "core.content.search",
    description: "Search content across the site. Uses full-text search.",
    kind: "read",
  },
  { name: "core.content.get", description: "Read one entry in full.", kind: "read" },
  { name: "core.settings.get", description: "Read a site setting.", kind: "read" },
  {
    name: "content.gallery_item.list",
    description: "List gallery entries as summaries.",
    kind: "read",
  },
  {
    name: "content.gallery_item.update",
    description: "Update one gallery entry.",
    kind: "write",
  },
];

describe("tool 名稱拆解", () => {
  it("命名空間與動詞", () => {
    expect(toolNamespace("content.gallery_item.update")).toBe("content.gallery_item");
    expect(toolLeaf("content.gallery_item.update")).toBe("update");
  });

  it("沒有點的名字不會被拆壞", () => {
    expect(toolNamespace("solo")).toBe("solo");
    expect(toolLeaf("solo")).toBe("solo");
  });

  it("blurb 取 description 的第一句、去掉句點", () => {
    expect(toolBlurb("Search content across the site. Uses full-text search.")).toBe(
      "Search content across the site",
    );
  });
});

describe("斜線觸發的判準", () => {
  it("行首的 / 觸發", () => {
    expect(readSlashQuery("/cont", 5)).toEqual({ start: 0, query: "cont" });
  });

  it("空白之後的 / 觸發", () => {
    const text = "幫我用 /core";
    expect(readSlashQuery(text, text.length)).toEqual({ start: 4, query: "core" });
  });

  it("剛打出 / 時就觸發(空 query = 顯示全部)", () => {
    expect(readSlashQuery("/", 1)).toEqual({ start: 0, query: "" });
  });

  it("字中間的斜線不觸發 —— 誤判會蓋住輸入框", () => {
    expect(readSlashQuery("a/b", 3)).toBeNull();
    const url = "看 https://example.com/x";
    expect(readSlashQuery(url, url.length)).toBeNull();
  });

  it("游標之後的字不影響判斷", () => {
    expect(readSlashQuery("/core 後面還有字", 5)).toEqual({ start: 0, query: "core" });
  });

  it("token 結束(空白)之後不再觸發", () => {
    expect(readSlashQuery("/core ", 6)).toBeNull();
  });
});

describe("選定工具", () => {
  it("把 /query 換成 tool 名 + 空白,游標落在空白之後", () => {
    const slash = readSlashQuery("/gall", 5);
    if (!slash) throw new Error("expected slash query");
    const next = applySlashSelection("/gall", slash, 5, "content.gallery_item.list");
    expect(next.text).toBe("content.gallery_item.list ");
    expect(next.caret).toBe(next.text.length);
  });

  it("保留游標之後的既有內容", () => {
    const text = "請 /gall 這些";
    const slash = readSlashQuery(text, 7);
    if (!slash) throw new Error("expected slash query");
    const next = applySlashSelection(text, slash, 7, "content.gallery_item.list");
    expect(next.text).toBe("請 content.gallery_item.list  這些");
  });

  it("插入之後不會再觸發選單(尾端是空白)", () => {
    const slash = readSlashQuery("/gall", 5);
    if (!slash) throw new Error("expected slash query");
    const next = applySlashSelection("/gall", slash, 5, "content.gallery_item.list");
    expect(readSlashQuery(next.text, next.caret)).toBeNull();
  });
});

describe("工具比對", () => {
  it("空 query 回全部,依名字排序", () => {
    const all = matchTools(TOOLS, "");
    expect(all).toHaveLength(TOOLS.length);
    expect(all[0].name).toBe("content.gallery_item.list");
  });

  it("前綴命中排在包含命中之前", () => {
    const hits = matchTools(TOOLS, "core.");
    expect(hits.map((h) => h.name)).toEqual([
      "core.content.get",
      "core.content.search",
      "core.settings.get",
    ]);
  });

  it("動詞開頭也命中(記得動作、忘了命名空間)", () => {
    expect(matchTools(TOOLS, "update").map((h) => h.name)).toEqual([
      "content.gallery_item.update",
    ]);
  });

  it("description 命中排最後,不與名字命中混在一起", () => {
    const hits = matchTools(TOOLS, "gallery");
    expect(hits[0].name).toBe("content.gallery_item.list");
    expect(hits.map((h) => h.name)).toContain("content.gallery_item.update");
  });

  it("完全不符 → 空清單(選單自己說找不到)", () => {
    expect(matchTools(TOOLS, "zzzz")).toEqual([]);
  });

  it("limit 生效", () => {
    expect(matchTools(TOOLS, "", 2)).toHaveLength(2);
  });
});

describe("確認卡的參數表", () => {
  it("純量逐列攤開,字串不加引號", () => {
    expect(flattenArgs({ id: "abc", count: 3, live: true, gone: null })).toEqual([
      { key: "id", depth: 0, value: "abc" },
      { key: "count", depth: 0, value: "3" },
      { key: "live", depth: 0, value: "true" },
      { key: "gone", depth: 0, value: "null" },
    ]);
  });

  it("巢狀物件縮排展開,容器列標出子項數", () => {
    const rows = flattenArgs({ id: "abc", data: { title: "新標題", order: 2 } });
    expect(rows).toEqual([
      { key: "id", depth: 0, value: "abc" },
      { key: "data", depth: 0, value: null, hint: "2" },
      { key: "title", depth: 1, value: "新標題" },
      { key: "order", depth: 1, value: "2" },
    ]);
  });

  it("純量陣列排成一行(展開只會多幾列而不多資訊)", () => {
    expect(flattenArgs({ tags: ["a", "b", "c"] })).toEqual([
      { key: "tags", depth: 0, value: "a, b, c" },
    ]);
  });

  it("物件陣列展開成 [0]/[1]", () => {
    const rows = flattenArgs({ items: [{ id: "x" }, { id: "y" }] });
    expect(rows.map((r) => r.key)).toEqual(["items", "[0]", "id", "[1]", "id"]);
    expect(rows[1].depth).toBe(1);
    expect(rows[2].depth).toBe(2);
  });

  it("超過深度上限就整段以 JSON 顯示,並且**標注**", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    const rows = flattenArgs(deep);
    const jsonRow = rows.find((r) => r.hint === "json");
    expect(jsonRow).toBeDefined();
    expect(jsonRow?.depth).toBe(ARG_MAX_DEPTH);
    expect(jsonRow?.value).toContain("\"e\":1");
  });

  it("過長的值截斷", () => {
    const rows = flattenArgs({ body: "x".repeat(ARG_VALUE_MAX_CHARS * 2) });
    expect(rows[0].value?.length).toBe(ARG_VALUE_MAX_CHARS + 1); // +1 = 省略號
    expect(rows[0].value?.endsWith("…")).toBe(true);
  });

  it("列數上限:停下來並補一列標注,不靜默截斷", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < ARG_MAX_ROWS * 2; i++) big[`k${i}`] = i;
    const rows = flattenArgs(big);
    expect(rows.length).toBe(ARG_MAX_ROWS + 1);
    expect(rows[rows.length - 1]).toMatchObject({ hint: "truncated" });
  });

  it("非物件的 args 也看得見(模型送得出來)", () => {
    expect(flattenArgs("just a string")).toEqual([
      { key: "value", depth: 0, value: "just a string" },
    ]);
    expect(flattenArgs(undefined)).toEqual([]);
  });
});
