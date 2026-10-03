import itertools
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from shop.money import format_money
from shop.notifications.mailer import Mailer
from shop.orders.inventory import InventoryStore, release_stock, reserve_stock
from shop.orders.loyalty import loyalty_points_for
from shop.orders.models import Order, PlaceOrder
from shop.payments.gateway import PaymentError, PaymentGateway
from shop.pricing.quote import build_quote

CANCEL_WINDOW = timedelta(hours=24)


class OrderNotFoundError(LookupError):
    pass


class CancellationWindowClosed(Exception):
    pass


class OrderService:
    def __init__(
        self,
        inventory: InventoryStore,
        payments: PaymentGateway,
        mailer: Mailer,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self._inventory = inventory
        self._payments = payments
        self._mailer = mailer
        self._now = now
        self._orders: dict[str, Order] = {}
        self._ids = itertools.count(1)

    def get(self, order_id: str) -> Order | None:
        return self._orders.get(order_id)

    def place_order(self, request: PlaceOrder) -> Order:
        quote = build_quote(request.lines, request.customer.region, request.coupon)
        items = [(line.sku, line.quantity) for line in request.lines]
        reserve_stock(self._inventory, items)

        order_id = f"ord_{next(self._ids)}"
        try:
            charge = self._payments.charge(request.payment_token, quote.total, idempotency_key=order_id)
        except Exception:
            release_stock(self._inventory, items)
            raise
        if charge.status != "succeeded":
            release_stock(self._inventory, items)
            raise PaymentError("card declined", charge.decline_code)

        order = Order(
            id=order_id,
            customer_id=request.customer.id,
            lines=request.lines,
            total=quote.total,
            charge_id=charge.id,
            created_at=self._now(),
            loyalty_points=loyalty_points_for(request.customer, quote.total),
        )
        self._orders[order.id] = order
        try:
            self._mailer.send(
                request.customer.email,
                "order-confirmation",
                {"order_id": order.id, "total": format_money(order.total), "points": order.loyalty_points},
            )
        except Exception:
            pass  # a failed confirmation email must not fail a paid order
        return order

    def cancel_order(self, order_id: str) -> Order:
        order = self._orders.get(order_id)
        if order is None:
            raise OrderNotFoundError(order_id)
        if order.status == "cancelled":
            return order
        if self._now() - order.created_at > CANCEL_WINDOW:
            raise CancellationWindowClosed(order_id)
        self._payments.refund(order.charge_id)
        release_stock(self._inventory, [(line.sku, line.quantity) for line in order.lines])
        cancelled = replace(order, status="cancelled", loyalty_points=0)
        self._orders[order_id] = cancelled
        return cancelled
