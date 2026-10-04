import { describe, it, expect } from "vitest";
import { applyRichtextEdits, richtextChangePreview, richtextOutline } from "../src/ext/dx/fields/richtext-edit";
import { agentPreviewSchema } from "../src/ext/agent-preview";

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const img = (key: string, alt = "") => ({ type: "image", attrs: { src: `/api/files/${key}`, alt } });

const DOC = {
  type: "doc",
  content: [p("前陣子參加了 CEO 講堂。"), p("傳承,是我們共同的考題。"), img("core/2026/10/a.png", "論壇現場"), p("講堂結束後,我一直在想一句話。")],
};

function apply(edits: Parameters<typeof applyRichtextEdits>[1]) {
  const result = applyRichtextEdits(DOC, edits);
  if (!result.ok) throw new Error(result.error);
  return result.doc.content ?? [];
}

describe("richtextOutline", () => {
  it("列出每個最上層區塊的位置、種類與開頭的字;圖片用替代文字與路徑", () => {
    expect(richtextOutline(DOC)).toEqual([
      { index: 0, type: "paragraph", text: "前陣子參加了 CEO 講堂。" },
      { index: 1, type: "paragraph", text: "傳承,是我們共同的考題。" },
      { index: 2, type: "image", text: "論壇現場 /api/files/core/2026/10/a.png" },
      { index: 3, type: "paragraph", text: "講堂結束後,我一直在想一句話。" },
    ]);
  });
});

describe("applyRichtextEdits", () => {
  it("在指定的段落後面插入一張圖,其餘區塊不動", () => {
    const out = apply([{ op: "insert", match: "共同的考題", blocks: [img("core/2026/10/b.png")] }]);
    expect(out).toEqual([DOC.content[0], DOC.content[1], img("core/2026/10/b.png"), DOC.content[2], DOC.content[3]]);
  });

  it("position: before / start / end;沒說位置就接在最後;字串變成段落", () => {
    expect(apply([{ op: "insert", index: 0, position: "before", blocks: ["開頭"] }])[0]).toEqual(p("開頭"));
    expect(apply([{ op: "insert", position: "start", blocks: ["開頭"] }])[0]).toEqual(p("開頭"));
    expect(apply([{ op: "insert", position: "end", blocks: ["結尾"] }]).at(-1)).toEqual(p("結尾"));
    expect(apply([{ op: "insert", blocks: ["一\n\n二"] }]).slice(-2)).toEqual([p("一"), p("二")]);
  });

  it("replace 換掉一塊,remove 拿掉一塊;圖片可以用替代文字或檔名指到", () => {
    const out = apply([
      { op: "replace", index: 1, blocks: ["傳承是共同的考題。"] },
      { op: "remove", match: "論壇現場" },
    ]);
    expect(out).toEqual([DOC.content[0], p("傳承是共同的考題。"), DOC.content[3]]);
    expect(apply([{ op: "remove", match: "a.png" }])).toHaveLength(3);
  });

  it("同一次的每個修改都指修改前的文件:前面插了東西,後面的 index 不必跟著算", () => {
    const out = apply([
      { op: "insert", index: 0, blocks: ["插在第一段後"] },
      { op: "remove", index: 3 },
    ]);
    expect(out).toEqual([DOC.content[0], p("插在第一段後"), DOC.content[1], DOC.content[2]]);
  });

  it("指不到、指到不只一塊、同一塊被改兩次 → 整組不套用,訊息帶著大綱", () => {
    const none = applyRichtextEdits(DOC, [{ op: "remove", match: "不存在的字" }]);
    expect(none).toMatchObject({ ok: false });
    expect(!none.ok && none.error).toContain("0 paragraph: 前陣子");

    const many = applyRichtextEdits(DOC, [{ op: "remove", match: "講堂" }]);
    expect(!many.ok && many.error).toContain("blocks 0, 3");

    expect(applyRichtextEdits(DOC, [{ op: "remove", index: 9 }])).toMatchObject({ ok: false });
    expect(applyRichtextEdits(DOC, [{ op: "replace", blocks: ["x"] }])).toMatchObject({ ok: false });
    // 說了 before / after 卻沒說是哪一塊:不猜,退回。
    expect(applyRichtextEdits(DOC, [{ op: "insert", position: "after", blocks: ["x"] }])).toMatchObject({ ok: false });
    // index 與 match 都給:那一塊裡要有那段字,否則內文已經不是當初看到的樣子。
    expect(applyRichtextEdits(DOC, [{ op: "remove", index: 1, match: "共同的考題" }])).toMatchObject({ ok: true });
    expect(applyRichtextEdits(DOC, [{ op: "remove", index: 0, match: "共同的考題" }])).toMatchObject({ ok: false });
    expect(
      applyRichtextEdits(DOC, [{ op: "remove", index: 1 }, { op: "replace", index: 1, blocks: ["x"] }]),
    ).toMatchObject({ ok: false });
  });

  it("不改動傳進來的文件;空文件也能插入", () => {
    const before = JSON.stringify(DOC);
    apply([{ op: "remove", index: 0 }]);
    expect(JSON.stringify(DOC)).toBe(before);
    const empty = applyRichtextEdits({ type: "doc", content: [] }, [{ op: "insert", blocks: ["第一段"] }]);
    expect(empty).toMatchObject({ ok: true, doc: { type: "doc", content: [p("第一段")] } });
  });
});

describe("richtextChangePreview", () => {
  const LONG = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "緣起" }] },
      p("一"), p("二"), p("三"), p("四"), p("五"), p("六"),
    ],
  };
  const preview = (doc: typeof LONG, edits: Parameters<typeof applyRichtextEdits>[1]) => {
    const result = applyRichtextEdits(doc, edits);
    if (!result.ok) throw new Error(result.error);
    return richtextChangePreview(result.steps);
  };

  it("改動的每一塊,前後各留一塊沒變的當位置,其餘收成「N 段不變」", () => {
    const out = preview(LONG, [
      { op: "insert", match: "三", blocks: [img("core/2026/10/b.png", "合影")] },
      { op: "remove", match: "六" },
    ]);
    expect(out).toEqual({
      kind: "changes",
      lines: [
        { change: "gap", count: 3 },
        { change: "kept", text: "三" },
        { change: "added", text: "合影", image: "/api/files/core/2026/10/b.png" },
        { change: "kept", text: "四" },
        { change: "kept", text: "五" },
        { change: "removed", text: "六" },
      ],
    });
    expect(agentPreviewSchema.safeParse(out).success).toBe(true);
  });

  it("replace = 舊的移除、新的加入,放在同一個位置;標題標得出來", () => {
    const out = preview(LONG, [{ op: "replace", index: 0, blocks: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "為什麼參加" }] }] }]);
    expect(out?.lines.slice(0, 3)).toEqual([
      { change: "removed", text: "緣起", heading: true },
      { change: "added", text: "為什麼參加", heading: true },
      { change: "kept", text: "一" },
    ]);
  });

  it("改動多到畫不完 → 不給預覽(只畫一部分會讓人以為那就是全部)", () => {
    const blocks = Array.from({ length: 50 }, (_, i) => `第 ${i} 段`);
    expect(preview(LONG, [{ op: "insert", blocks }, { op: "insert", position: "start", blocks }])).toBeUndefined();
  });
});
