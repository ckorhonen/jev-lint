# shop-api

Small FastAPI service. `pytest` runs the tests; `ruff check .` lints.

- `app/main.py` — the FastAPI app and routes
- `app/db.py` — SQLAlchemy engine and `get_db` session dependency (SQLite)
- `app/models.py` — ORM models
- `app/auth.py` — `get_current_user` dependency (reads the `X-User-Id` header)
- `app/clients/payments.py` — the payments provider's Python SDK (synchronous)
- `app/notifications.py` — outgoing email
