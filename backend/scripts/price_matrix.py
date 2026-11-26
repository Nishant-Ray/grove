"""Print which GPUs clear the electricity floor, per priority, across all states.

Reads the live (public) rate tables, so edits in the Supabase dashboard show up here.
Usage, from backend/:  .venv/bin/python scripts/price_matrix.py [--states]
"""
import os
import sys
from decimal import Decimal
from pathlib import Path

import httpx
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import pricing  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[1] / ".env")


def fetch(client, table, select="*"):
    response = client.get(f"/rest/v1/{table}", params={"select": select})
    response.raise_for_status()
    return response.json()


def main():
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_PUBLISHABLE_KEY")
    if not url or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in backend/.env")
    with httpx.Client(base_url=url.rstrip("/"), headers={"apikey": key}, timeout=12) as client:
        gpus = [g for g in fetch(client, "gpu_rates") if g["active"]]
        levels = sorted(fetch(client, "priority_levels"), key=lambda p: p["sort_order"])
        settings = fetch(client, "grove_settings")[0]
        rates = {r["state"]: Decimal(str(r["usd_per_kwh"])) for r in fetch(client, "electricity_rates")}

    share, margin = Decimal(str(settings["host_share"])), Decimal(str(settings["floor_margin"]))
    overhead = Decimal(str(settings["system_overhead_kw"]))
    states = sorted(s for s in rates if s != "US")
    print(f"{'GPU':<20}{'priority':<10}{'price/hr':>9}{'payout':>9}{'US floor':>9}  states passing")
    for g in sorted(gpus, key=lambda g: g["base_rate_usd_hr"]):
        power = Decimal(str(g["power_kw"])) + overhead
        for level in levels:
            price = pricing.hourly_price(Decimal(str(g["base_rate_usd_hr"])), Decimal(str(level["multiplier"])))
            payout = pricing.host_payout(price, share)
            floor = pricing.power_floor(power, rates["US"], margin)
            failing = [s for s in states if not pricing.clears_floor(payout, pricing.power_floor(power, rates[s], margin))]
            mark = "" if pricing.clears_floor(payout, floor) else "  <-- FAILS NATIONALLY"
            detail = f"  (fails: {' '.join(failing)})" if failing and "--states" in sys.argv else ""
            print(f"{g['label']:<20}{level['id']:<10}{price:>9}{payout:>9}{floor:>9}  "
                  f"{len(states) - len(failing)}/{len(states)}{mark}{detail}")


if __name__ == "__main__":
    main()
