# shop-core

Order, pricing and invoicing logic for the shop backend. TypeScript, tested with Vitest.

- `npm test` runs the tests (`vitest run`); `npm run typecheck` type-checks.
- Tests live next to the code as `*.test.ts` (see `src/lib/money.test.ts`).

Layout:

- `src/lib/money.ts` — integer-cents helpers and currency formatting
- `src/pricing/quote.ts` — cart pricing: volume tiers, coupons, regional tax, shipping
- `src/orders/` — `OrderService` (place/cancel orders), stock reservation, loyalty points
- `src/payments/gateway.ts` — client for the Paywise charges API
- `src/notifications/mailer.ts` — client for the Postbox transactional email API
- `src/reports/invoice.ts` — renders invoices as HTML documents
- `src/clients/carrier.ts` — client for the ShipFast carrier API (rates and tracking); response types in `carrier-api.ts`
