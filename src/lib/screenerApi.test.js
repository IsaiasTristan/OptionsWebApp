import { describe, it, expect } from "vitest";
import { computeRollingRV } from "./screenerApi.js";

describe("computeRollingRV", () => {
  it("returns empty when insufficient rows", () => {
    expect(computeRollingRV([], 20)).toEqual([]);
    expect(computeRollingRV([{ trade_date: "2026-01-01", close: 10 }], 20)).toEqual([]);
  });

  it("produces rv20 series for flat prices ~0 vol", () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      const d = String(i + 1).padStart(2, "0");
      rows.push({ trade_date: `2026-01-${d}`, close: 100 });
    }
    const out = computeRollingRV(rows, 20);
    expect(out.length).toBeGreaterThan(0);
    out.forEach((p) => {
      expect(p.rv20).toBeGreaterThanOrEqual(0);
      expect(p.date).toMatch(/2026-01-/);
    });
  });
});
