import type { ApiError, ApiRatesResponse, ApiTrackingResponse } from "./carrier-api";

export type Address = { line1: string; city: string; postalCode: string; country: string };
export type Parcel = { weightGrams: number; lengthCm: number; widthCm: number; heightCm: number };

export type Rate = { service: string; name: string; amountCents: number; currency: string; estimatedDays: number | null };
export type Tracking = { trackingNumber: string; status: string; delivered: boolean; lastLocation: string | null; history: { at: Date; status: string; message: string }[] };

export class CarrierError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** Client for the ShipFast carrier API v2. */
export class CarrierClient {
  constructor(
    private apiKey: string,
    private options: { baseUrl?: string; fetchImpl?: typeof fetch; maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  private get baseUrl() {
    return this.options.baseUrl ?? "https://api.shipfast.example/v2";
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const maxRetries = this.options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      });
      if (res.status === 404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        let code: string | undefined;
        let message = `ShipFast request failed with HTTP ${res.status}`;
        try {
          const body = (await res.json()) as ApiError;
          code = body.error.code;
          message = body.error.message;
        } catch {
          // not JSON
        }
        throw new CarrierError(message, res.status, code);
      }
      return (await res.json()) as T;
    }
  }

  /** Quotes for a parcel, cheapest first. */
  async getRates(from: Address, to: Address, parcel: Parcel): Promise<Rate[]> {
    if (parcel.weightGrams <= 0) throw new Error("parcel weight must be positive");
    const body = await this.request<ApiRatesResponse>("/rates", {
      method: "POST",
      body: JSON.stringify({
        from: { line1: from.line1, city: from.city, postal_code: from.postalCode, country: from.country },
        to: { line1: to.line1, city: to.city, postal_code: to.postalCode, country: to.country },
        parcel: { weight_g: parcel.weightGrams, length_cm: parcel.lengthCm, width_cm: parcel.widthCm, height_cm: parcel.heightCm },
      }),
    });
    if (!body) throw new CarrierError("rates endpoint not found", 404);
    return body.rates
      .map((r) => ({ service: r.service_code, name: r.service_name, amountCents: r.amount_cents, currency: r.currency, estimatedDays: r.estimated_days }))
      .sort((a, b) => a.amountCents - b.amountCents);
  }

  /** Tracking for a parcel, or null when ShipFast does not know the number. */
  async track(trackingNumber: string): Promise<Tracking | null> {
    const body = await this.request<ApiTrackingResponse>(`/tracking/${encodeURIComponent(trackingNumber)}`);
    if (!body) return null;
    const history = body.events
      .map((e) => ({ at: new Date(e.occurred_at), status: e.status, message: e.message, location: e.location }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const last = history.at(-1);
    return {
      trackingNumber: body.tracking_number,
      status: last?.status ?? "unknown",
      delivered: last?.status === "delivered",
      lastLocation: [...history].reverse().find((e) => e.location)?.location ?? null,
      history: history.map(({ at, status, message }) => ({ at, status, message })),
    };
  }
}
