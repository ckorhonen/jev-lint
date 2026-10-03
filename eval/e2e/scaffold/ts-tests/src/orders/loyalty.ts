import type { Cents } from "../lib/money";
import type { Customer } from "./types";

/** One point per whole dollar spent; gold members earn double. */
export function loyaltyPointsFor(customer: Customer, total: Cents): number {
  const base = Math.floor(total / 100);
  return customer.loyaltyTier === "gold" ? base * 2 : base;
}
