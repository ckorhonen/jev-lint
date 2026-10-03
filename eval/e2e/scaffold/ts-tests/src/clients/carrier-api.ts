// Wire types for the ShipFast carrier API v2 (snake_case, as documented by ShipFast).

export type ApiRate = {
  service_code: string;
  service_name: string;
  amount_cents: number;
  currency: string;
  estimated_days: number | null;
};

export type ApiRatesResponse = { shipment_id: string; rates: ApiRate[] };

export type ApiTrackingEvent = { occurred_at: string; status: "label_created" | "in_transit" | "out_for_delivery" | "delivered" | "exception"; location: string | null; message: string };

export type ApiTrackingResponse = { tracking_number: string; carrier: string; events: ApiTrackingEvent[] };

export type ApiError = { error: { code: string; message: string } };
