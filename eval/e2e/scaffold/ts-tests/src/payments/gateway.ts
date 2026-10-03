import type { Cents } from "../lib/money";

export type Charge = { id: string; status: "succeeded" | "declined"; amount: Cents; declineCode?: string };

export class PaymentError extends Error {
  constructor(message: string, readonly declineCode?: string) {
    super(message);
  }
}

/** Client for the Paywise charges API. */
export class PaymentGateway {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.paywise.example/v1",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async charge(token: string, amount: Cents, idempotencyKey: string): Promise<Charge> {
    const res = await this.fetchImpl(`${this.baseUrl}/charges`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ source: token, amount, currency: "usd" }),
    });
    if (!res.ok) throw new PaymentError(`charge failed with HTTP ${res.status}`);
    const body = (await res.json()) as { id: string; status: "succeeded" | "declined"; amount: number; decline_code?: string };
    return { id: body.id, status: body.status, amount: body.amount, declineCode: body.decline_code };
  }

  async refund(chargeId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/charges/${chargeId}/refunds`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new PaymentError(`refund failed with HTTP ${res.status}`);
  }
}
