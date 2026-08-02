import { describe, expect, it } from "vitest";
import { collectText, OG_FONT_FAMILY, OG_FONT_WEIGHTS } from "@/components/og/subset-text";

// 這個檔只測純邏輯(文字收集與字型常數)。實際產圖需要 yoga/resvg 的 wasm,
// 那要在真的 Workers 上跑 —— 見檔尾「無法在此驗證的部分」。

describe("collectText — 決定字型子集要抓哪些字", () => {
  // 漏掉任何一段會被渲染的文字,那幾個字在 OG 圖上就是豆腐塊,
  // 而且**不會有錯誤** —— 圖照樣產出,只是字變方框。所以覆蓋率就是正確性。
  it("攤平巢狀的 props", () => {
    const out = collectText({
      title: "繁體中文標題",
      meta: { author: "Suko", tags: ["訂單", "金流"] },
      count: 42,
    });
    for (const s of ["繁體中文標題", "Suko", "訂單", "金流", "42"]) {
      expect(out).toContain(s);
    }
  });

  it("陣列與巢狀陣列都收得到", () => {
    expect(collectText([["甲"], ["乙", ["丙"]]])).toContain("丙");
  });

  it("忽略非文字值,不會把 null/undefined 變成字面字串", () => {
    const out = collectText({ a: null, b: undefined, c: true, d: "只有這個" });
    expect(out).not.toContain("null");
    expect(out).not.toContain("undefined");
    expect(out).toContain("只有這個");
  });

  it("深度有上限,環狀結構不會爆堆疊", () => {
    const cyclic: Record<string, unknown> = { name: "根" };
    cyclic.self = cyclic;
    expect(() => collectText(cyclic)).not.toThrow();
    expect(collectText(cyclic)).toContain("根");
  });

  it("空物件回空字串(呼叫端據此避免送空的 text 給 Google)", () => {
    expect(collectText({}).trim()).toBe("");
  });
});

describe("OG 字型設定", () => {
  it("用 Chiron GoRound TC —— 與站台字型同家族,且在 Google Fonts 上", () => {
    // Chiron Hei HK(站上 self-host 的那顆)也在 Google Fonts,但 GoRound 是
    // 可變字重,對 OG 這種要多個 weight 的場景更省。
    expect(OG_FONT_FAMILY).toBe("Chiron GoRound TC");
  });

  it("只抓兩個字重 —— 每個字重都是一次獨立往返", () => {
    // 模板實際用到 500/600/700/800,satori 會對應到最接近的可用字重。
    // 想加字重的人要知道代價是多一次網路抓取,不是免費的。
    expect([...OG_FONT_WEIGHTS]).toEqual([400, 700]);
  });
});

// ---- 無法在此驗證的部分 ----------------------------------------------------
//
// 以下三件事只有在真的 Cloudflare Workers 上跑才驗得到,vitest 的 workers pool
// 重現不了(wasm 的載入方式與 OpenNext 的打包有關,不是 workerd 本身的行為):
//
//   1. yoga / resvg 的 wasm 能不能載入(next/og 在這裡會炸
//      `Wasm code generation disallowed by embedder`)
//   2. 產出的 PNG 裡 CJK 是不是真的有字形而不是豆腐塊
//   3. loadGoogleFont 的子集大小與延遲
//
// 這三點已在一個獨立的臨時 Worker 上實測過(2026-08-03):PNG 1200×630、
// 繁中正常渲染、字型子集 6,680 bytes / 53ms、無任何 wasm 錯誤。
//
// ⚠️ 換掉 workers-og 或改動這個 route 的人,請重跑一次那個實測 ——
// **失敗是靜默的**:body 是串流,錯誤要讀取時才浮現,所以壞掉的請求會回
// `HTTP 200 / image/png / 0 bytes`,看起來像成功。
