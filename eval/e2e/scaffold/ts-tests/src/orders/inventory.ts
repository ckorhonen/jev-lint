/** Stock levels per SKU. Reservations are all-or-nothing. */
export class InventoryStore {
  private stock = new Map<string, number>();

  constructor(initial: Record<string, number> = {}) {
    for (const [sku, qty] of Object.entries(initial)) this.stock.set(sku, qty);
  }

  available(sku: string): number {
    return this.stock.get(sku) ?? 0;
  }

  set(sku: string, qty: number) {
    this.stock.set(sku, qty);
  }
}

export class OutOfStockError extends Error {
  constructor(readonly sku: string, readonly requested: number, readonly available: number) {
    super(`not enough stock for ${sku}: requested ${requested}, available ${available}`);
  }
}

export function reserveStock(store: InventoryStore, items: { sku: string; quantity: number }[]) {
  const wanted = new Map<string, number>();
  for (const item of items) wanted.set(item.sku, (wanted.get(item.sku) ?? 0) + item.quantity);
  for (const [sku, qty] of wanted) {
    if (store.available(sku) < qty) throw new OutOfStockError(sku, qty, store.available(sku));
  }
  for (const [sku, qty] of wanted) store.set(sku, store.available(sku) - qty);
}

export function releaseStock(store: InventoryStore, items: { sku: string; quantity: number }[]) {
  for (const item of items) store.set(item.sku, store.available(item.sku) + item.quantity);
}
