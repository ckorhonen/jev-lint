import unittest
from decimal import Decimal

from pricing.pricing import line_total, order_total


class PricingTest(unittest.TestCase):
    def test_line_total_rounds_to_cents(self):
        self.assertEqual(line_total(Decimal("0.333"), 3), Decimal("1.00"))

    def test_order_total_sums_lines(self):
        self.assertEqual(order_total([(Decimal("2.50"), 2), (Decimal("1.25"), 4)]), Decimal("10.00"))


if __name__ == "__main__":
    unittest.main()
