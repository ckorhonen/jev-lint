from collections import Counter


class OutOfStockError(Exception):
    def __init__(self, sku: str, requested: int, available: int):
        super().__init__(f"not enough stock for {sku}: requested {requested}, available {available}")
        self.sku = sku
        self.requested = requested
        self.available = available


class InventoryStore:
    """Stock levels per SKU."""

    def __init__(self, initial: dict[str, int] | None = None):
        self._stock: dict[str, int] = dict(initial or {})

    def available(self, sku: str) -> int:
        return self._stock.get(sku, 0)

    def set(self, sku: str, qty: int) -> None:
        self._stock[sku] = qty


def reserve_stock(store: InventoryStore, items: list[tuple[str, int]]) -> None:
    """All-or-nothing reservation of (sku, quantity) pairs."""
    wanted = Counter()
    for sku, qty in items:
        wanted[sku] += qty
    for sku, qty in wanted.items():
        if store.available(sku) < qty:
            raise OutOfStockError(sku, qty, store.available(sku))
    for sku, qty in wanted.items():
        store.set(sku, store.available(sku) - qty)


def release_stock(store: InventoryStore, items: list[tuple[str, int]]) -> None:
    for sku, qty in items:
        store.set(sku, store.available(sku) + qty)
