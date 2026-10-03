import { type Cents, roundCents } from "../lib/money";

export type Region = "US-CA" | "US-NY" | "US-OR" | "EU-DE" | "EU-FR";

export type QuoteLine = { sku: string; unitPrice: Cents; quantity: number; taxExempt?: boolean };

export type Coupon =
  | { code: string; kind: "percent"; percent: number; minSubtotal?: Cents }
  | { code: string; kind: "fixed"; amount: Cents; minSubtotal?: Cents }
  | { code: string; kind: "free-shipping" };

export type Quote = {
  lines: { sku: string; quantity: number; unitPrice: Cents; lineTotal: Cents; volumeDiscount: Cents }[];
  subtotal: Cents;
  couponDiscount: Cents;
  shipping: Cents;
  tax: Cents;
  total: Cents;
  appliedCoupon: string | null;
};

export const TAX_RATES: Record<Region, number> = {
  "US-CA": 0.0725,
  "US-NY": 0.04,
  "US-OR": 0,
  "EU-DE": 0.19,
  "EU-FR": 0.2,
};

/** Per-line volume discount: 10+ units 5% off, 50+ units 10% off, 100+ units 15% off. */
export function volumeDiscountRate(quantity: number): number {
  if (quantity >= 100) return 0.15;
  if (quantity >= 50) return 0.1;
  if (quantity >= 10) return 0.05;
  return 0;
}

export const FREE_SHIPPING_THRESHOLD: Cents = 7500;
export const FLAT_SHIPPING: Cents = 695;

export class QuoteError extends Error {}

export function buildQuote(lines: QuoteLine[], region: Region, coupon?: Coupon): Quote {
  if (lines.length === 0) throw new QuoteError("cart is empty");
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new QuoteError(`invalid quantity for ${line.sku}`);
    if (line.unitPrice < 0) throw new QuoteError(`invalid price for ${line.sku}`);
  }

  const priced = lines.map((line) => {
    const gross = line.unitPrice * line.quantity;
    const volumeDiscount = roundCents(gross * volumeDiscountRate(line.quantity));
    return { ...line, lineTotal: gross - volumeDiscount, volumeDiscount };
  });
  const subtotal = priced.reduce((sum, l) => sum + l.lineTotal, 0);

  let couponDiscount = 0;
  let appliedCoupon: string | null = null;
  let freeShipping = subtotal >= FREE_SHIPPING_THRESHOLD;
  if (coupon) {
    const min = "minSubtotal" in coupon ? (coupon.minSubtotal ?? 0) : 0;
    if (subtotal >= min) {
      appliedCoupon = coupon.code;
      if (coupon.kind === "percent") couponDiscount = roundCents(subtotal * (coupon.percent / 100));
      else if (coupon.kind === "fixed") couponDiscount = Math.min(coupon.amount, subtotal);
      else freeShipping = true;
    }
  }

  // The coupon discount is spread over taxable lines in proportion to their totals.
  const taxable = priced.filter((l) => !l.taxExempt).reduce((sum, l) => sum + l.lineTotal, 0);
  const taxableAfterCoupon = subtotal === 0 ? 0 : taxable - roundCents(couponDiscount * (taxable / subtotal));
  const tax = roundCents(taxableAfterCoupon * TAX_RATES[region]);
  const shipping = freeShipping ? 0 : FLAT_SHIPPING;

  return {
    lines: priced.map(({ sku, quantity, unitPrice, lineTotal, volumeDiscount }) => ({ sku, quantity, unitPrice, lineTotal, volumeDiscount })),
    subtotal,
    couponDiscount,
    shipping,
    tax,
    total: subtotal - couponDiscount + shipping + tax,
    appliedCoupon,
  };
}
