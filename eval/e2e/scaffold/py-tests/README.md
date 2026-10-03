# shop-core

Order, pricing and customer logic for the shop backend. Python 3.11, tested with pytest.

- `pytest` runs the tests (they live in `tests/`, see `tests/test_money.py`).

Layout:

- `shop/money.py` — Decimal money helpers
- `shop/pricing/quote.py` — cart pricing: volume tiers, coupons, regional VAT, shipping
- `shop/orders/` — `OrderService` (place/cancel orders), stock reservation, loyalty points
- `shop/payments/gateway.py` — client for the Paywise charges API (httpx)
- `shop/notifications/mailer.py` — client for the Postbox transactional email API (httpx)
- `shop/clients/fx.py` — client for the RateBridge exchange-rate API; wire types in `fx_types.py`
- `shop/db/client.py` — thin `Database` wrapper over a DB-API connection (SQLite in dev); schema in `shop/db/schema.sql`
- `shop/repositories/customers.py` — `CustomerRepository` (customers and their order stats)
