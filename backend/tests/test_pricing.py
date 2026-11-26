import unittest
from decimal import Decimal as D

from app import pricing


class PricingTest(unittest.TestCase):
    def test_price_is_base_times_priority_times_reliability(self):
        self.assertEqual(pricing.hourly_price(D("0.2730"), D("1.30")), D("0.3549"))
        self.assertEqual(pricing.hourly_price(D("0.2730"), D("1.00")), D("0.2730"))
        self.assertEqual(pricing.hourly_price(D("0.2730"), D("1.30"), D("1.1")), D("0.3904"))

    def test_payout_and_fee_split_the_price_exactly(self):
        for price in (D("0.3549"), D("0.0800"), D("0.1041"), D("1.0001")):
            payout = pricing.host_payout(price, D("0.8"))
            self.assertEqual(payout + pricing.grove_fee(price, D("0.8")), price)
        self.assertEqual(pricing.host_payout(D("0.3549"), D("0.8")), D("0.2839"))

    def test_power_floor_filters_hosts_with_expensive_power(self):
        # 4090 board 0.45 kW + 0.1 kW overhead at $0.165/kWh with a 1.5× margin.
        floor = pricing.power_floor(D("0.55"), D("0.165"), D("1.5"))
        self.assertEqual(floor, D("0.1362"))  # 0.136125 rounded up
        self.assertTrue(pricing.clears_floor(D("0.2839"), floor))   # Standard 4090
        self.assertTrue(pricing.clears_floor(D("0.2184"), floor))   # Batch 4090
        self.assertTrue(pricing.clears_floor(floor, floor))         # boundary passes
        self.assertFalse(pricing.clears_floor(D("0.1361"), floor))
        california = pricing.power_floor(D("0.55"), D("0.32"), D("1.5"))
        self.assertFalse(pricing.clears_floor(D("0.2184"), california))  # Batch drops out

    def test_estimate_and_reserve(self):
        estimate = pricing.estimate_micros(D("0.3549"), D("2"))
        self.assertEqual(estimate, 709_800)
        self.assertEqual(pricing.reserve_micros(estimate, D("1.25")), 887_250)
        self.assertEqual(pricing.reserve_micros(3, D("1.25")), 4)  # rounds up
        self.assertEqual(pricing.micros_to_usd(709_800), D("0.71"))
        self.assertEqual(pricing.micros_to_usd(887_250, round_up=True), D("0.89"))

    def test_per_second_charge_is_capped_at_the_reserve(self):
        self.assertEqual(pricing.charge_micros(D("0.3549"), 90, 887_250), 8_873)
        self.assertEqual(pricing.charge_micros(D("0.3549"), 0, 887_250), 0)
        self.assertEqual(pricing.charge_micros(D("0.3549"), 3 * 3600, 887_250), 887_250)
        with self.assertRaises(ValueError):
            pricing.charge_micros(D("0.3549"), -1, 887_250)

    def test_reliability_is_stubbed_at_one(self):
        self.assertEqual(pricing.reliability(), D("1.0"))
        self.assertEqual(pricing.reliability({"avg_rating": 1, "review_count": 50}), D("1.0"))
