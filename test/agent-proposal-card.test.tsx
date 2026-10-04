import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { getMessages } from "@/lib/i18n/index";
import { ProposalCard } from "../src/components/admin/agent/ProposalCard";
import type { AgentProposal } from "../src/ext/agent-loop";

// 1.70.0:提案帶著預覽時,確認卡畫的是「會改動的地方」,參數收在後面。

const BASE: AgentProposal = {
  toolName: "content.blog_post.edit_text",
  toolUseId: "tu-1",
  args: { id: "abc", field: "body", edits: [{ op: "insert", match: "參數裡的字" }] },
  summary: "修改一筆「文章」的內文(id: abc;新增 1 處)",
};

const render = (proposal: AgentProposal) =>
  renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale: "zh-Hant", messages: getMessages("zh-Hant") },
      createElement(ProposalCard, {
        proposal,
        resolution: "pending",
        running: false,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    ),
  );

describe("ProposalCard", () => {
  it("沒有預覽 → 照舊是參數表", () => {
    const html = render(BASE);
    expect(html).toContain("參數");
    expect(html).toContain("參數裡的字");
    expect(html).not.toContain("會改動的地方");
    expect(html).not.toContain("<details");
  });

  it("有預覽 → 畫出沒變、加入(含圖片)、移除、略過的段數;參數收進 details", () => {
    const html = render({
      ...BASE,
      preview: {
        kind: "changes",
        lines: [
          { change: "kept", text: "第一段。" },
          { change: "added", text: "論壇現場", image: "/api/files/core/2026/10/abc.png" },
          { change: "removed", text: "要拿掉的一段。" },
          { change: "gap", count: 4 },
        ],
      },
    });
    expect(html).toContain("會改動的地方");
    expect(html).toContain("第一段。");
    expect(html).toContain('src="/api/files/core/2026/10/abc.png?w=640"');
    expect(html).toContain('alt="論壇現場"');
    expect(html).toContain('aria-label="加入"');
    expect(html).toContain('aria-label="移除"');
    expect(html).toContain("line-through");
    expect(html).toContain("4 段不變");
    // 參數還在,但在 details 裡。
    expect(html.indexOf("<details")).toBeGreaterThan(-1);
    expect(html.indexOf("參數裡的字")).toBeGreaterThan(html.indexOf("<details"));
    // 確認與取消照舊。
    expect(html).toContain("確認執行");
  });
});
