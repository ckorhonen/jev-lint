import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA = Path(__file__).with_name("schema.sql")

Row = dict[str, Any]


class Database:
    """Thin wrapper over a DB-API connection (SQLite in dev and tests, Postgres in production via the same API)."""

    def __init__(self, conn: sqlite3.Connection):
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        self._conn = conn
        self._autocommit = True

    @classmethod
    def connect(cls, url: str = ":memory:") -> "Database":
        return cls(sqlite3.connect(url))

    def migrate(self) -> None:
        self._conn.executescript(SCHEMA.read_text())

    def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        """Run a statement; returns lastrowid for inserts, else the affected row count."""
        cur = self._conn.execute(sql, params)
        if self._autocommit:
            self._conn.commit()
        return cur.lastrowid if sql.lstrip().upper().startswith("INSERT") else cur.rowcount

    def fetch_one(self, sql: str, params: Sequence[Any] = ()) -> Row | None:
        row = self._conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def fetch_all(self, sql: str, params: Sequence[Any] = ()) -> list[Row]:
        return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    @contextmanager
    def transaction(self) -> Iterator[None]:
        self._autocommit = False
        try:
            yield
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        finally:
            self._autocommit = True
