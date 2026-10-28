import { describe, expect, it } from "vitest";
import { extensionBasePath, parseVersionRefs, pickInstallable } from "../src/lib/registry-versions";

// registry 保留的舊版本:index 的 `versions` 怎麼解析、這個站該裝哪一版。

describe("parseVersionRefs", () => {
  it("丟掉格式不對的項目,由新到舊排好", () => {
    expect(
      parseVersionRefs([
        { version: "0.9.0", coreApi: "^1.10.0" },
        { version: "1.0", coreApi: "^1.0.0" },
        { version: "0.10.0", coreApi: "^1.20.0" },
        { version: "0.8.0" },
        "0.7.0",
      ]),
    ).toEqual([
      { version: "0.10.0", coreApi: "^1.20.0" },
      { version: "0.9.0", coreApi: "^1.10.0" },
    ]);
  });

  it("沒有、不是陣列、或全部不對 → undefined", () => {
    expect(parseVersionRefs(undefined)).toBeUndefined();
    expect(parseVersionRefs({ version: "1.0.0" })).toBeUndefined();
    expect(parseVersionRefs([{ version: "x" }])).toBeUndefined();
  });
});

describe("pickInstallable", () => {
  const latest = { version: "0.3.0", coreApi: "^1.79.0" };
  const kept = [
    { version: "0.2.2", coreApi: "^1.54.0" },
    { version: "0.1.0", coreApi: "^1.10.0" },
  ];

  it("最新版相容就是最新版", () => {
    expect(pickInstallable(latest, kept, "1.85.0")).toEqual({ ...latest, archived: false });
  });

  it("最新版不相容:第一個相容的舊版本", () => {
    expect(pickInstallable(latest, kept, "1.60.0")).toEqual({ version: "0.2.2", coreApi: "^1.54.0", archived: true });
    expect(pickInstallable(latest, kept, "1.20.0")).toEqual({ version: "0.1.0", coreApi: "^1.10.0", archived: true });
  });

  it("都不相容 → null", () => {
    expect(pickInstallable(latest, kept, "1.5.0")).toBeNull();
    expect(pickInstallable(latest, undefined, "1.5.0")).toBeNull();
  });
});

describe("extensionBasePath", () => {
  it("最新版沒有 versions 那一層", () => {
    expect(extensionBasePath("cron")).toBe("/extensions/cron");
    expect(extensionBasePath("cron", "1.0.3")).toBe("/extensions/cron/versions/1.0.3");
  });
});
