from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal

from shop.money import to_money

Region = Literal["US-CA", "US-NY", "US-OR", "EU-DE", "EU-FR"]

VAT_RATES: dict[str, Decimal] = {
    "US-CA": Decimal("0.0725"),
    "US-NY": Decimal("0.04"),
    "US-OR": Decimal("0"),
    "EU-DE": Decimal("0.19"),
    "EU-FR": Decimal("0.20"),
}
FREE_SHIPPING_THRESHOLD = Decimal("75.00")
FLAT_SHIPPING = Decimal("6.95")


class QuoteError(ValueError):
    pass


@dataclass(frozen=True)
class QuoteLine:
    sku: str
    unit_price: Decimal
    quantity: int
    tax_exempt: bool = False


@dataclass(frozen=True)
class Coupon:
    code: str
    kind: Literal["percent", "fixed", "free_shipping"]
    value: Decimal = Decimal("0")  # percent (e.g. 15) or fixed amount
    min_subtotal: Decimal = Decimal("0")


@dataclass
class PricedLine:
    sku: str
    quantity: int
    unit_price: Decimal
    volume_discount: Decimal
    line_total: Decimal


@dataclass
class Quote:
    lines: list[PricedLine] = field(default_factory=list)
    subtotal: Decimal = Decimal("0")
    coupon_discount: Decimal = Decimal("0")
    shipping: Decimal = Decimal("0")
    tax: Decimal = Decimal("0")
    total: Decimal = Decimal("0")
    applied_coupon: str | None = None


def volume_discount_rate(quantity: int) -> Decimal:
    """10+ units 5% off, 50+ units 10% off, 100+ units 15% off (per line)."""
    if quantity >= 100:
        return Decimal("0.15")
    if quantity >= 50:
        return Decimal("0.10")
    if quantity >= 10:
        return Decimal("0.05")
    return Decimal("0")


def build_quote(lines: list[QuoteLine], region: Region, coupon: Coupon | None = None) -> Quote:
    if not lines:
        raise QuoteError("cart is empty")
    if region not in VAT_RATES:
        raise QuoteError(f"unsupported region {region}")
    priced: list[PricedLine] = []
    for line in lines:
        if line.quantity <= 0:
            raise QuoteError(f"invalid quantity for {line.sku}")
        if line.unit_price < 0:
            raise QuoteError(f"invalid price for {line.sku}")
        gross = line.unit_price * line.quantity
        discount = to_money(gross * volume_discount_rate(line.quantity))
        priced.append(PricedLine(line.sku, line.quantity, line.unit_price, discount, to_money(gross - discount)))

    subtotal = sum((p.line_total for p in priced), Decimal("0"))
    coupon_discount = Decimal("0")
    applied = None
    free_shipping = subtotal >= FREE_SHIPPING_THRESHOLD
    if coupon and subtotal >= coupon.min_subtotal:
        applied = coupon.code
        if coupon.kind == "percent":
            coupon_discount = to_money(subtotal * coupon.value / 100)
        elif coupon.kind == "fixed":
            coupon_discount = min(to_money(coupon.value), subtotal)
        else:
            free_shipping = True

    # The coupon discount is spread over taxable lines in proportion to their totals.
    taxable = sum((p.line_total for p, src in zip(priced, lines, strict=True) if not src.tax_exempt), Decimal("0"))
    taxable_after_coupon = taxable - to_money(coupon_discount * taxable / subtotal) if subtotal else Decimal("0")
    tax = to_money(taxable_after_coupon * VAT_RATES[region])
    shipping = Decimal("0.00") if free_shipping else FLAT_SHIPPING
    return Quote(
        lines=priced,
        subtotal=subtotal,
        coupon_discount=coupon_discount,
        shipping=shipping,
        tax=tax,
        total=subtotal - coupon_discount + shipping + tax,
        applied_coupon=applied,
    )
