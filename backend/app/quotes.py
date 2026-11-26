"""Public rate tables and per-host price quotes."""
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from . import pricing
from .accounts import Client, Token, call

router = APIRouter(prefix="/api")
SLUG = r"^[a-z0-9_-]{1,40}$"
Hours = Annotated[Decimal, Query(ge=Decimal("0.01"), le=168, decimal_places=2)]


def dec(value) -> Decimal:
    # PostgREST returns numeric columns as JSON numbers; go through str to keep them exact.
    return Decimal(str(value))


def priced(row: dict, hours: Decimal, stats=None) -> dict:
    """Price one host from its pricing inputs (a quote_inputs or recommend_hosts row)."""
    if row.get("usd_per_kwh") is None or row.get("host_share") is None:
        # A missing settings row or national electricity rate is a configuration error.
        raise HTTPException(503, "Pricing is temporarily unavailable.")
    share = dec(row["host_share"])
    reliability = pricing.reliability(stats)
    rate = pricing.hourly_price(dec(row["base_rate_usd_hr"]), dec(row["priority_multiplier"]), reliability)
    payout = pricing.host_payout(rate, share)
    floor = pricing.power_floor(dec(row["power_kw"]), dec(row["usd_per_kwh"]), dec(row["floor_margin"]))
    estimate = pricing.estimate_micros(rate, hours)
    return {
        "reliability": reliability, "rate": rate, "payout": payout,
        "fee": pricing.grove_fee(rate, share), "floor": floor,
        "clears_floor": pricing.clears_floor(payout, floor),
        "estimate_micros": estimate,
        "reserve_micros": pricing.reserve_micros(estimate, dec(row["reserve_multiplier"])),
        "payout_estimate_micros": pricing.estimate_micros(payout, hours),
    }


async def device_price(client, token, host_device_id: UUID, priority: str, hours: Decimal,
                       gpu: str | None = None) -> tuple[dict, dict]:
    rows = await call(client, "POST", "/rest/v1/rpc/quote_inputs", token=token,
                      json={"p_device_id": str(host_device_id), "p_priority": priority})
    if not rows:
        raise HTTPException(404, "Host device could not be found.")
    row = rows[0]
    if row["gpu_model"] is None:
        raise HTTPException(409, "This device does not list a supported GPU.")
    if gpu and gpu != row["gpu_model"]:
        raise HTTPException(422, "The GPU does not match this host device.")
    if row["priority_multiplier"] is None:
        raise HTTPException(422, "Unknown priority level.")
    return row, priced(row, hours)


@router.get("/gpu-rates")
async def gpu_rates(client: Client):
    return await call(client, "GET", "/rest/v1/gpu_rates", params={
        "select": "gpu_model,label,vram_gb,base_rate_usd_hr", "active": "eq.true",
        "order": "base_rate_usd_hr,gpu_model",
    })


@router.get("/priority-levels")
async def priority_levels(client: Client):
    return await call(client, "GET", "/rest/v1/priority_levels", params={
        "select": "id,label,multiplier,description", "order": "sort_order,id",
    })


@router.get("/quote")
async def quote(client: Client, token: Token, host_device_id: UUID,
                priority: Annotated[str, Query(pattern=SLUG)], hours: Hours,
                gpu: Annotated[str | None, Query(pattern=SLUG)] = None):
    row, p = await device_price(client, token, host_device_id, priority, hours, gpu)
    return {
        "host_device_id": str(host_device_id),
        "gpu": row["gpu_model"],
        "gpu_label": row["gpu_label"],
        "priority": priority,
        "hours": str(hours),
        "reliability": str(p["reliability"]),
        "rate_per_hr": str(p["rate"]),
        "host_payout_per_hr": str(p["payout"]),
        "grove_fee_per_hr": str(p["fee"]),
        "power_floor_per_hr": str(p["floor"]),
        "clears_floor": p["clears_floor"],
        "kwh_source": row["kwh_source"],
        "green_energy": row["green_energy"],
        "estimate": str(pricing.micros_to_usd(p["estimate_micros"])),
        "reserve": str(pricing.micros_to_usd(p["reserve_micros"], round_up=True)),
        "host_payout_estimate": str(pricing.micros_to_usd(p["payout_estimate_micros"])),
    }
