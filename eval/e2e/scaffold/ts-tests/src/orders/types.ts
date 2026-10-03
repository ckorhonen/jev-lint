import type { Cents } from "../lib/money";
import type { Coupon, QuoteLine, Region } from "../pricing/quote";

export type Customer = { id: string; email: string; name: string; region: Region; loyaltyTier: "standard" | "gold" };

export type OrderStatus = "paid" | "cancelled";

export type Order = {
  id: string;
  customerId: string;
  lines: QuoteLine[];
  total: Cents;
  chargeId: string;
  status: OrderStatus;
  loyaltyPoints: number;
  createdAt: Date;
};

export type PlaceOrderInput = { customer: Customer; lines: QuoteLine[]; coupon?: Coupon; paymentToken: string };
