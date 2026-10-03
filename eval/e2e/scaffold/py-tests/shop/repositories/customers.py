import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from shop.db.client import Database, Row

Tier = Literal["standard", "gold"]
GOLD_THRESHOLD_CENTS = 100_000  # $1,000 of paid orders


class DuplicateEmailError(ValueError):
    pass


@dataclass(frozen=True)
class Customer:
    id: int
    email: str
    name: str
    tier: Tier
    created_at: datetime


@dataclass(frozen=True)
class CustomerStats:
    customer: Customer
    order_count: int
    lifetime_spend: Decimal


def _to_customer(row: Row) -> Customer:
    return Customer(row["id"], row["email"], row["name"], row["tier"], datetime.fromisoformat(row["created_at"]))


class CustomerRepository:
    def __init__(self, db: Database):
        self._db = db

    def create(self, email: str, name: str, now: datetime | None = None) -> Customer:
        email = email.strip().lower()
        created = (now or datetime.now(UTC)).isoformat()
        try:
            new_id = self._db.execute("INSERT INTO customers (email, name, created_at) VALUES (?, ?, ?)", (email, name, created))
        except sqlite3.IntegrityError as e:
            raise DuplicateEmailError(email) from e
        found = self.get(new_id)
        assert found is not None
        return found

    def get(self, customer_id: int) -> Customer | None:
        row = self._db.fetch_one("SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL", (customer_id,))
        return _to_customer(row) if row else None

    def find_by_email(self, email: str) -> Customer | None:
        row = self._db.fetch_one(
            "SELECT * FROM customers WHERE email = ? AND deleted_at IS NULL", (email.strip().lower(),)
        )
        return _to_customer(row) if row else None

    def soft_delete(self, customer_id: int, now: datetime | None = None) -> bool:
        changed = self._db.execute(
            "UPDATE customers SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
            ((now or datetime.now(UTC)).isoformat(), customer_id),
        )
        return changed == 1

    def stats(self, customer_id: int) -> CustomerStats | None:
        customer = self.get(customer_id)
        if customer is None:
            return None
        row = self._db.fetch_one(
            "SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS spend FROM orders WHERE customer_id = ? AND status = 'paid'",
            (customer_id,),
        )
        assert row is not None
        return CustomerStats(customer, row["n"], Decimal(row["spend"]) / 100)

    def refresh_tier(self, customer_id: int) -> Tier:
        """Promote to gold once paid orders reach the threshold; never demote."""
        stats = self.stats(customer_id)
        if stats is None:
            raise LookupError(customer_id)
        if stats.customer.tier == "gold" or stats.lifetime_spend * 100 < GOLD_THRESHOLD_CENTS:
            return stats.customer.tier
        self._db.execute("UPDATE customers SET tier = 'gold' WHERE id = ?", (customer_id,))
        return "gold"

    def top_spenders(self, limit: int = 10) -> list[CustomerStats]:
        rows = self._db.fetch_all(
            """
            SELECT c.*, COUNT(o.id) AS n, COALESCE(SUM(o.total_cents), 0) AS spend
            FROM customers c JOIN orders o ON o.customer_id = c.id AND o.status = 'paid'
            WHERE c.deleted_at IS NULL
            GROUP BY c.id
            ORDER BY spend DESC, c.id ASC
            LIMIT ?
            """,
            (limit,),
        )
        return [CustomerStats(_to_customer(r), r["n"], Decimal(r["spend"]) / 100) for r in rows]
