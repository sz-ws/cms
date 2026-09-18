import { describe, it, expect } from "vitest";
import { ADMIN_ACCENT_BOOT_SCRIPT, ADMIN_ACCENT_STORAGE_KEY } from "../src/lib/admin-accent";

// 後台主色的 boot script(lib/admin-accent.ts):畫面出來前讀 localStorage 快取套上。
// 用假的 localStorage / document 執行那段字串,測它只接受 #rrggbb。

function runBoot(stored: string | null) {
  const styles: { id: string; textContent: string }[] = [];
  const localStorage = {
    getItem: (key: string) => (key === ADMIN_ACCENT_STORAGE_KEY ? stored : null),
  };
  const document = {
    getElementById: (id: string) => styles.find((s) => s.id === id) ?? null,
    createElement: () => ({ id: "", textContent: "" }),
    head: {
      appendChild: (el: { id: string; textContent: string }) => {
        styles.push(el);
        return el;
      },
    },
  };
  new Function("localStorage", "document", ADMIN_ACCENT_BOOT_SCRIPT)(localStorage, document);
  return styles;
}

describe("ADMIN_ACCENT_BOOT_SCRIPT", () => {
  it("套上存的主色與主色上的字色", () => {
    const styles = runBoot(JSON.stringify({ accent: "#e0457b", fg: "#ffffff" }));
    expect(styles).toEqual([
      { id: "cms-admin-accent", textContent: ":root{--admin-accent:#e0457b;--admin-accent-fg:#ffffff}" },
    ]);
  });

  it("沒存過、JSON 壞掉或不是 #rrggbb 時什麼都不做(不拼進 CSS)", () => {
    expect(runBoot(null)).toEqual([]);
    expect(runBoot("{not json")).toEqual([]);
    expect(runBoot(JSON.stringify({ accent: "red", fg: "#ffffff" }))).toEqual([]);
    expect(
      runBoot(JSON.stringify({ accent: "#e0457b;}body{display:none", fg: "#ffffff" })),
    ).toEqual([]);
    expect(runBoot(JSON.stringify({ accent: "#e0457b" }))).toEqual([]);
  });

  it("快取是預設色時不插 <style>(globals.css 已經是它)", () => {
    expect(runBoot(JSON.stringify({ accent: "#5672e4", fg: "#ffffff" }))).toEqual([]);
  });
});
