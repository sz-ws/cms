import { describe, expect, it } from "vitest";
import {
  isStaleInstallConflict,
  migrationHistoryChanged,
} from "../src/ext/dx/install-contract";

describe("declarative install update contract", () => {
  it("allows only append-only migration history", () => {
    const a = "CREATE TABLE IF NOT EXISTS ext_x (id TEXT PRIMARY KEY)";
    const b = "CREATE INDEX IF NOT EXISTS ext_x_id ON ext_x (id)";
    expect(migrationHistoryChanged([a], [a, b])).toBe(false);
    expect(migrationHistoryChanged([a], [b])).toBe(true);
    expect(migrationHistoryChanged([a, b], [a])).toBe(true);
  });

  it("classifies only migration-marker unique failures as stale conflicts", () => {
    const wrapped = new Error("Failed query", {
      cause: new Error("UNIQUE constraint failed: ext_migrations.id"),
    });
    expect(isStaleInstallConflict(wrapped)).toBe(true);
    expect(isStaleInstallConflict(new Error("syntax error near CREATE"))).toBe(false);
  });
});
