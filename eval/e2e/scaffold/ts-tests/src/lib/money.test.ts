import { describe, expect, it } from "vitest";
import { formatMoney, roundCents, toCents } from "./money";

describe("money", () => {
  it("converts dollars to cents", () => {
    expect(toCents(12.34)).toBe(1234);
  });

  it("rounds half away from zero", () => {
    expect(roundCents(2.5)).toBe(3);
    expect(roundCents(-2.5)).toBe(-3);
  });

  it("formats cents as currency", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
  });
});
