import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/ext/dx/manifest";

// 1.25.0:宣告式 manifest 的 files[](progressive 的打包那一半)。
//
// 這裡的路徑檢查不是形式主義:files[] 的每個字串都會被 CLI 拿去組本機檔案路徑並
// 寫檔,而 manifest 可能來自任何一個被加進 core.registrySources 的來源。

function manifest(extra: Record<string, unknown> = {}) {
  return {
    kind: "declarative",
    id: "catalog",
    name: "Catalog",
    version: "0.1.0",
    coreApi: "^1.25.0",
    contentTypes: [
      { name: "product", fields: [{ key: "name", type: "text", label: "Name" }] },
    ],
    ...extra,
  };
}

describe("declarative manifest files[]", () => {
  it("沒宣告 files 的 manifest 照樣過(絕大多數 extension 不需要強化層)", () => {
    const r = parseManifest(manifest());
    expect(r.error ?? "ok").toBe("ok");
    expect(r.manifest?.files).toBeUndefined();
  });

  it("一般檔名與子目錄都收", () => {
    const r = parseManifest(
      manifest({ files: ["index.ts", "views/product-card.tsx", "README.md"] }),
    );
    expect(r.error ?? "ok").toBe("ok");
    expect(r.manifest?.files).toEqual([
      "index.ts",
      "views/product-card.tsx",
      "README.md",
    ]);
  });

  it("deployment: progressive 與 files 併用(這就是它存在的理由)", () => {
    const r = parseManifest(
      manifest({ deployment: "progressive", files: ["index.ts"] }),
    );
    expect(r.error ?? "ok").toBe("ok");
  });

  // ---- 路徑逃逸:每一條都是「會被寫進檔案系統」的字串 ----

  it("上層穿越拒收", () => {
    expect(parseManifest(manifest({ files: ["../../../etc/passwd"] })).ok).toBe(
      false,
    );
    // 每個字元都在白名單裡,靠 refine 擋
    expect(parseManifest(manifest({ files: ["views/../../secret.ts"] })).ok).toBe(
      false,
    );
    expect(parseManifest(manifest({ files: [".."] })).ok).toBe(false);
  });

  it("絕對路徑拒收", () => {
    expect(parseManifest(manifest({ files: ["/etc/passwd"] })).ok).toBe(false);
    expect(parseManifest(manifest({ files: ["C:/Windows/system32"] })).ok).toBe(
      false,
    );
  });

  it("反斜線拒收(Windows 分隔符與跳脫)", () => {
    expect(parseManifest(manifest({ files: ["..\\..\\secret"] })).ok).toBe(false);
    expect(parseManifest(manifest({ files: ["views\\card.tsx"] })).ok).toBe(
      false,
    );
  });

  it("空字串、空白、null byte 拒收", () => {
    expect(parseManifest(manifest({ files: [""] })).ok).toBe(false);
    expect(parseManifest(manifest({ files: ["a b.ts"] })).ok).toBe(false);
    expect(parseManifest(manifest({ files: ["a\u0000.ts"] })).ok).toBe(false);
  });

  it("超長路徑與超多檔案拒收", () => {
    expect(parseManifest(manifest({ files: [`${"a".repeat(200)}.ts`] })).ok).toBe(
      false,
    );
    const many = Array.from({ length: 65 }, (_, i) => `f${i}.ts`);
    expect(parseManifest(manifest({ files: many })).ok).toBe(false);
  });

  it("files 不是陣列時拒收", () => {
    expect(parseManifest(manifest({ files: "index.ts" })).ok).toBe(false);
  });
});
