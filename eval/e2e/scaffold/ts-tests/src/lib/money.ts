/** Money is always integer cents. */
export type Cents = number;

export function toCents(amount: number): Cents {
  return Math.round(amount * 100);
}

/** Round half away from zero to whole cents. */
export function roundCents(value: number): Cents {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function formatMoney(cents: Cents, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
