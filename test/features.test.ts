import { describe, it, expect } from "vitest";
import { missingCapabilities, CORE_FEATURES } from "../src/ext/features";

describe("missingCapabilities", () => {
  it("returns [] for undefined", () => {
    expect(missingCapabilities(undefined)).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(missingCapabilities([])).toEqual([]);
  });

  it("returns [] when every requested capability is known", () => {
    expect(missingCapabilities([...CORE_FEATURES])).toEqual([]);
    expect(missingCapabilities(["contents", "media"])).toEqual([]);
  });

  it("returns only the unknown names, deduped, in stable (first-seen) order", () => {
    expect(
      missingCapabilities([
        "contents",
        "time-travel",
        "media",
        "time-travel",
        "quantum-sync",
      ]),
    ).toEqual(["time-travel", "quantum-sync"]);
  });

  it("is case-sensitive (a differently-cased known name is still unknown)", () => {
    expect(missingCapabilities(["Media"])).toEqual(["Media"]);
    expect(missingCapabilities(["media"])).toEqual([]);
  });
});
