import { formatMoney } from "../lib/money";
import type { Mailer } from "../notifications/mailer";
import { type PaymentGateway, PaymentError } from "../payments/gateway";
import { buildQuote } from "../pricing/quote";
import { type InventoryStore, releaseStock, reserveStock } from "./inventory";
import { loyaltyPointsFor } from "./loyalty";
import type { Order, PlaceOrderInput } from "./types";

export class OrderNotFoundError extends Error {}

export class OrderService {
  private orders = new Map<string, Order>();
  private seq = 0;

  constructor(
    private inventory: InventoryStore,
    private payments: PaymentGateway,
    private mailer: Mailer,
    private now: () => Date = () => new Date(),
  ) {}

  get(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  async placeOrder(input: PlaceOrderInput): Promise<Order> {
    const quote = buildQuote(input.lines, input.customer.region, input.coupon);
    reserveStock(this.inventory, input.lines);

    const orderId = `ord_${++this.seq}`;
    let charge;
    try {
      charge = await this.payments.charge(input.paymentToken, quote.total, orderId);
    } catch (err) {
      releaseStock(this.inventory, input.lines);
      throw err;
    }
    if (charge.status !== "succeeded") {
      releaseStock(this.inventory, input.lines);
      throw new PaymentError("card declined", charge.declineCode);
    }

    const order: Order = {
      id: orderId,
      customerId: input.customer.id,
      lines: input.lines,
      total: quote.total,
      chargeId: charge.id,
      status: "paid",
      loyaltyPoints: loyaltyPointsFor(input.customer, quote.total),
      createdAt: this.now(),
    };
    this.orders.set(order.id, order);

    // A failed confirmation email must not fail a paid order.
    await this.mailer
      .send(input.customer.email, "order-confirmation", { orderId: order.id, total: formatMoney(order.total), points: order.loyaltyPoints })
      .catch(() => undefined);
    return order;
  }

  async cancelOrder(orderId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    if (order.status === "cancelled") return order;
    const ageMs = this.now().getTime() - order.createdAt.getTime();
    if (ageMs > 24 * 60 * 60 * 1000) throw new Error("orders can only be cancelled within 24 hours");

    await this.payments.refund(order.chargeId);
    releaseStock(this.inventory, order.lines);
    const cancelled: Order = { ...order, status: "cancelled", loyaltyPoints: 0 };
    this.orders.set(orderId, cancelled);
    return cancelled;
  }
}
