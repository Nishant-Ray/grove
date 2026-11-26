"""Grove platform pricing. Pure functions only; inputs come from the pricing tables.

    price/hr     = base[gpu] × priority multiplier × reliability[host]
    host payout  = price × host_share            (Grove keeps the rest)
    power floor  = power_kW × $/kWh × floor_margin
    a host is shown for a job only if payout/hr ≥ power floor

Hourly rates are rounded to 4 decimal places. Job totals are kept in integer
micro-dollars (1 USD = 1_000_000) so per-second billing stays exact.
"""
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import Any, Mapping

RATE = Decimal("0.0001")
CENT = Decimal("0.01")
MICROS_PER_USD = 1_000_000
ONE = Decimal("1.0")


def _rate(value: Decimal) -> Decimal:
    return value.quantize(RATE, ROUND_HALF_UP)


def hourly_price(base: Decimal, multiplier: Decimal, reliability: Decimal = ONE) -> Decimal:
    return _rate(base * multiplier * reliability)


def host_payout(price: Decimal, host_share: Decimal) -> Decimal:
    return _rate(price * host_share)


def grove_fee(price: Decimal, host_share: Decimal) -> Decimal:
    # Derived from the rounded payout so payout + fee always equals the price.
    return price - host_payout(price, host_share)


def power_floor(power_kw: Decimal, usd_per_kwh: Decimal, margin: Decimal) -> Decimal:
    # Round up so a host is never shown for a payout that falls short of its true floor.
    return (power_kw * usd_per_kwh * margin).quantize(RATE, ROUND_CEILING)


def clears_floor(payout_per_hr: Decimal, floor_per_hr: Decimal) -> bool:
    return payout_per_hr >= floor_per_hr


def to_micros(usd: Decimal) -> int:
    return int((usd * MICROS_PER_USD).to_integral_value(ROUND_HALF_UP))


def micros_to_usd(micros: int, *, round_up: bool = False) -> Decimal:
    usd = Decimal(micros) / MICROS_PER_USD
    return usd.quantize(CENT, ROUND_CEILING if round_up else ROUND_HALF_UP)


def estimate_micros(price_per_hr: Decimal, hours: Decimal) -> int:
    return to_micros(price_per_hr * hours)


def reserve_micros(estimate: int, reserve_multiplier: Decimal) -> int:
    # The renter's credits held for a job: estimate × 1.25, rounded up.
    return int((Decimal(estimate) * reserve_multiplier).to_integral_value(ROUND_CEILING))


def charge_micros(price_per_hr: Decimal, seconds: int, reserve_cap: int) -> int:
    """Per-second usage charge, never more than the credits reserved for the job."""
    if seconds < 0:
        raise ValueError("seconds must not be negative")
    return min(reserve_cap, to_micros(price_per_hr * seconds / 3600))


def reliability(stats: Mapping[str, Any] | None = None) -> Decimal:
    """Host reliability multiplier, intended range 0.9–1.1.

    Stubbed at 1.0 until there is real review data. Planned formula: once a host has
    at least 5 reviews, blend the average star rating with the objective completion
    rate (no-shows and host cancellations count against it) and clamp to [0.9, 1.1].
    """
    return ONE
