import { describe, it, expect } from "vitest";
import { bs, computeIV } from "./blackScholes.js";

describe("bs", () => {
  it("returns intrinsic for expired call", () => {
    const r = bs(100, 100, 0, 0.05, 0.2, "call");
    expect(r.price).toBe(0);
    expect(r.gamma).toBe(0);
  });

  it("prices ATM call with positive value", () => {
    const r = bs(100, 100, 30 / 365, 0.05, 0.25, "call");
    expect(r.price).toBeGreaterThan(2);
    expect(r.delta).toBeGreaterThan(0.45);
    expect(r.delta).toBeLessThan(0.58);
  });
});

describe("computeIV", () => {
  it("recovers vol near 25% for listed option", () => {
    const S = 100,
      K = 100,
      T = 0.25,
      r = 0.05;
    const sigma = 0.25;
    const price = bs(S, K, T, r, sigma, "call").price;
    const iv = computeIV(price, S, K, T, r, "call");
    expect(iv).toBeGreaterThan(0.24);
    expect(iv).toBeLessThan(0.26);
  });
});
