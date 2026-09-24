import { describe, it, expect, vi, beforeEach } from "vitest";

// slug 正規化(src/ext/dx/slug.ts)+ 網址兩端(route-matcher.ts 的 decodePathSegments /
// detailPath)+ 公開頁 dispatch((public)/[...slug]/page.tsx)的純邏輯測試。
//
// 這一檔釘三件事:
//   1. 純 ASCII 標題的 slug 與舊規則逐字相同 —— 舊規則就地複製在下面,拿亂數字串對拍;
//   2. 中日韓標題得到可讀的 slug,而且放進網址、再解回來還是同一個字串;
//   3. 請求裡的 slug 不管是編碼過的還是已解碼的都對得上,壞掉的 `%` 序列是 404 不是 500。

const runtime = vi.hoisted(() => ({ enabled: [] as unknown[] }));
vi.mock("@/ext/loader", () => ({ getExtRuntime: async () => runtime }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { slugify, slugifyDraft, SLUG_MAX_LENGTH } from "../src/ext/dx/slug";
import {
  compilePattern,
  decodePathSegments,
  detailPath,
  matchSegments,
} from "../src/ext/dx/route-matcher";
import PublicPage from "../src/app/(public)/[...slug]/page";

/** 改版前 content-provider.ts / SlugField.tsx 的規則,一字不改 —— 對拍用的基準。 */
function legacySlugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 固定種子的 PRNG(mulberry32):對拍的輸入每次都一樣,失敗可重現。 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASCII_ALPHABET =
  Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).join("") +
  "\t\n\r\f\v";

const SAMPLES = [
  "Hello World",
  "春季新品 2026!",
  "營業時間異動",
  "2026 春季新品 Sale",
  "【公告】營業時間異動",
  "春季新品，限時優惠。",
  "ＡＢＣ　１２３！",
  "コーヒー・ブレイク",
  "봄 신상품 안내",
  "नमस्ते दुनिया",
  "Crème Brûlée",
  "🌸 春季新品 🎉",
  "Don't Stop Me Now!",
  "  --Multiple   spaces--  ",
];

describe("slugify — 純 ASCII 與舊規則逐字相同", () => {
  it("常見的英文標題", () => {
    for (const title of [
      "Hello World",
      "Don't Stop Me Now!",
      "C++ & Rust: 2026 edition",
      "v1.2.3 release notes",
      "under_score and dash-es",
      "  --Multiple   spaces--  ",
      "Tabs\tand\nnewlines",
      "UPPER lower 123",
      "",
      "!!!",
    ]) {
      expect(slugify(title), title).toBe(legacySlugify(title));
    }
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("亂數 ASCII 字串對拍 2000 組(長度在上限內)", () => {
    const rand = prng(20260924);
    for (let n = 0; n < 2000; n++) {
      const len = Math.floor(rand() * 60);
      let s = "";
      for (let i = 0; i < len; i++) {
        s += ASCII_ALPHABET[Math.floor(rand() * ASCII_ALPHABET.length)];
      }
      expect(slugify(s), JSON.stringify(s)).toBe(legacySlugify(s));
    }
  });
});

describe("slugify — 任何語言的字母與數字", () => {
  it("中文:空白與標點變成 -,字本身留下", () => {
    expect(slugify("春季新品 2026!")).toBe("春季新品-2026");
    expect(slugify("營業時間異動")).toBe("營業時間異動");
    expect(slugify("2026 春季新品 Sale")).toBe("2026-春季新品-sale");
  });

  it("全形 / 中文標點是分隔,不會把兩個詞黏在一起", () => {
    expect(slugify("【公告】營業時間異動")).toBe("公告-營業時間異動");
    // 全形逗號 / 驚嘆號(U+FF0C / U+FF01)經 NFKC 會變成 ASCII 的 `,` `!`;分隔判定
    // 必須先於 NFKC,否則會落進「ASCII 標點刪除」那一步,兩個詞黏在一起。
    expect(slugify("春季新品，限時優惠。")).toBe("春季新品-限時優惠");
    expect(slugify("春季新品！限時優惠")).toBe("春季新品-限時優惠");
    // NFKC:全形英數 → 半形,全形空白 → 分隔。
    expect(slugify("ＡＢＣ　１２３！")).toBe("abc-123");
  });

  it("半形 ASCII 標點沿用舊規則:刪除,不當分隔", () => {
    // 與英文標題的舊行為一致(`don't` → `dont`);要斷詞請用空白或全形標點。
    expect(slugify("春季新品!限時優惠")).toBe("春季新品限時優惠");
    expect(slugify("營業時間異動 (10/1 起)")).toBe("營業時間異動-101-起");
  });

  it("日文、韓文、印度系文字(含組合記號)保持完整", () => {
    expect(slugify("コーヒー・ブレイク")).toBe("コーヒー-ブレイク");
    // 半形片假名經 NFKC 變全形,長音符(\p{Lm})留下。
    expect(slugify("ｺｰﾋｰ")).toBe("コーヒー");
    expect(slugify("봄 신상품 안내")).toBe("봄-신상품-안내");
    expect(slugify("नमस्ते दुनिया")).toBe("नमस्ते-दुनिया");
  });

  it("重音字母:組合式與預組式得到同一個 slug", () => {
    expect(slugify("Crème Brûlée")).toBe("crème-brûlée");
    expect(slugify("Crème Brûlée")).toBe("crème-brûlée");
  });

  it("emoji 一律丟掉(含變體選擇符、膚色、ZWJ 序列、keycap)", () => {
    expect(slugify("🌸 春季新品 🎉")).toBe("春季新品");
    expect(slugify("春季🌸新品")).toBe("春季-新品");
    expect(slugify("❤️愛")).toBe("愛");
    expect(slugify("👍🏽")).toBe("");
    expect(slugify("👨‍👩‍👧 family")).toBe("family");
    expect(slugify("1️⃣ 第一")).toBe("1-第一");
  });

  it("沒有可用字元 → 空字串", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("!!!")).toBe("");
    expect(slugify("、。「」")).toBe("");
    expect(slugify("🎉🎉")).toBe("");
  });

  it(`最長 ${SLUG_MAX_LENGTH} 個 code point,不切斷 surrogate pair`, () => {
    expect(Array.from(slugify("春".repeat(100)))).toHaveLength(SLUG_MAX_LENGTH);
    // U+20000(CJK 擴充 B)是 surrogate pair:以 UTF-16 長度截會切出孤立的半個字,
    // 那種字串連 encodeURIComponent 都會丟例外。
    const wide = slugify("𠀀".repeat(100));
    expect(Array.from(wide)).toHaveLength(SLUG_MAX_LENGTH);
    expect(wide.length).toBe(SLUG_MAX_LENGTH * 2);
    expect(() => encodeURIComponent(wide)).not.toThrow();
    // 截在分隔上 → 結尾的 - 也要修掉。
    expect(slugify(`${"a".repeat(SLUG_MAX_LENGTH - 1)} b`)).toBe(
      "a".repeat(SLUG_MAX_LENGTH - 1),
    );
  });

  it("冪等:已經是 slug 的字串再正規化一次不變(手打的 slug 存檔時再跑一次)", () => {
    for (const s of SAMPLES) {
      expect(slugify(slugify(s)), s).toBe(slugify(s));
    }
  });

  it("slug 不含 %:對已解碼的值再解一次原樣不動", () => {
    for (const s of SAMPLES) {
      expect(slugify(s)).not.toContain("%");
      expect(decodeURIComponent(slugify(s))).toBe(slugify(s));
    }
  });
});

describe("slugifyDraft — 輸入框逐字正規化", () => {
  it("保留結尾一個 -,才打得出第二個詞", () => {
    expect(slugifyDraft("春季 ")).toBe("春季-");
    expect(slugifyDraft("hello-")).toBe("hello-");
    expect(slugifyDraft("hello--")).toBe("hello-");
    expect(slugifyDraft("-hello")).toBe("hello");
  });

  it("收尾後與直接 slugify 相同", () => {
    for (const s of [...SAMPLES, "春季 ", "hello-", "a b c "]) {
      expect(slugify(slugifyDraft(s)), s).toBe(slugify(s));
    }
  });
});

describe("decodePathSegments / detailPath — 網址兩端", () => {
  const SLUG = "春季新品-2026";
  const ENCODED = encodeURIComponent(SLUG);

  it("編碼過的段解一次;已解碼的段原樣不動", () => {
    expect(decodePathSegments(["news", ENCODED])).toEqual(["news", SLUG]);
    expect(decodePathSegments(["news", SLUG])).toEqual(["news", SLUG]);
    expect(decodePathSegments([])).toEqual([]);
  });

  it("壞掉的 % 序列 → null(呼叫端回 404),不丟例外", () => {
    expect(decodePathSegments(["news", "%E6%98"])).toBeNull();
    expect(decodePathSegments(["%zz"])).toBeNull();
    expect(decodePathSegments(["news", "%"])).toBeNull();
  });

  it("detailPath 只輸出 ASCII,解回來是同一個 slug", () => {
    const path = detailPath("/news", SLUG);
    expect(path).toBe(`/news/${ENCODED}`);
    expect(path).toMatch(/^[\x21-\x7e]+$/);
    const segments = decodePathSegments(path.split("/").filter((s) => s.length > 0));
    expect(segments).toEqual(["news", SLUG]);
  });

  it("ASCII slug 的連結與以前一樣", () => {
    expect(detailPath("/gallery", "first-post")).toBe("/gallery/first-post");
  });

  it("pattern 是 /:slug(base = /)時不拼出 //slug", () => {
    expect(detailPath("/", "about")).toBe("/about");
    expect(detailPath("/", SLUG)).toBe(`/${ENCODED}`);
  });

  it("route matcher 拿到解碼後的段,對上 :slug", () => {
    const template = compilePattern("/news/:slug");
    const decoded = decodePathSegments(["news", ENCODED]);
    expect(decoded).not.toBeNull();
    expect(matchSegments(template, decoded!)).toEqual({ slug: SLUG });
  });
});

describe("(public)/[...slug] — 公開頁 dispatch", () => {
  const SLUG = "春季新品-2026";
  const Detail = () => null;

  beforeEach(() => {
    const template = compilePattern("/news/:slug");
    runtime.enabled = [
      {
        publicRoutes: [
          {
            match: (segments: string[]) => matchSegments(template, segments),
            component: Detail,
          },
        ],
      },
    ];
  });

  async function open(slug: string[]) {
    return (await PublicPage({ params: Promise.resolve({ slug }) })) as {
      type: unknown;
      props: { params: Record<string, string> };
    };
  }

  it("Next 交來編碼過的中文段 → detail 拿到解碼後的 slug", async () => {
    const el = await open(["news", encodeURIComponent(SLUG)]);
    expect(el.type).toBe(Detail);
    expect(el.props.params).toEqual({ slug: SLUG });
  });

  it("已解碼的段一樣對得上", async () => {
    const el = await open(["news", SLUG]);
    expect(el.props.params).toEqual({ slug: SLUG });
  });

  it("壞掉的 % 序列 → 404,不是 500", async () => {
    await expect(open(["news", "%E6%98"])).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("沒有 route 匹配 → 404", async () => {
    await expect(open(["other", SLUG])).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
