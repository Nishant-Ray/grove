"""Host discovery: match renters with available, compatible hosts at platform prices."""
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query

from . import pricing
from .accounts import Actor, Admin, rpc
from .quotes import SLUG, Hours, dec, priced

router = APIRouter(prefix="/api")


@router.get("/hosts/recommendations")
async def recommendations(
    admin: Admin, actor: Actor,
    priority: Annotated[str, Query(pattern=SLUG)] = "standard",
    hours: Hours = Decimal("1"),
    min_vram: Annotated[int, Query(ge=0, le=1024)] = 0,
    gpu: Annotated[str | None, Query(pattern=SLUG)] = None,
    sort: Literal["price", "rating", "green"] = "price",
    zip: Annotated[str | None, Query(pattern=r"^[0-9]{5}$")] = None,
    max_miles: Annotated[int | None, Query(gt=0, le=5000)] = None,
    green_only: bool = False,
):
    if max_miles and not zip:
        raise HTTPException(422, "Add your ZIP code to filter by distance.")
    rows = await rpc(admin, "recommend_hosts", {
        "p_actor": str(actor), "p_priority": priority, "p_min_vram": min_vram,
        "p_gpu_model": gpu, "p_renter_zip": zip,
    })
    hosts = []
    for row in rows:
        p = priced(row, hours)
        distance = None if row["distance_miles"] is None else dec(row["distance_miles"])
        # Never offer a host a job whose payout does not cover its power with margin.
        if not p["clears_floor"]:
            continue
        if green_only and not row["green_energy"]:
            continue
        if max_miles and (distance is None or distance > max_miles):
            continue
        hosts.append({
            "host_device_id": row["device_id"],
            "device_name": row["device_name"],
            "host_name": row["host_name"],
            "gpu": row["gpu_model"],
            "gpu_label": row["gpu_label"],
            "vram_gb": row["vram_gb"],
            "state": row["state"],
            "green_energy": row["green_energy"],
            "distance_miles": None if distance is None else int(distance.to_integral_value()),
            "rating": None,  # Reviews ship in a later milestone.
            "review_count": 0,
            "rate_per_hr": str(p["rate"]),
            "estimate": str(pricing.micros_to_usd(p["estimate_micros"])),
            "reserve": str(pricing.micros_to_usd(p["reserve_micros"], round_up=True)),
            "_rate": p["rate"], "_distance": distance,
        })

    far = Decimal("1e9")

    def by_price(h):
        return (h["_rate"], h["_distance"] if h["_distance"] is not None else far, h["host_device_id"])

    if sort == "green":
        hosts.sort(key=lambda h: (not h["green_energy"], *by_price(h)))
    elif sort == "rating":
        hosts.sort(key=lambda h: (h["rating"] is None, -(h["rating"] or 0), *by_price(h)))
    else:
        hosts.sort(key=by_price)
    for h in hosts:
        del h["_rate"], h["_distance"]
    return {"priority": priority, "hours": str(hours), "sort": sort, "hosts": hosts}


@router.post("/devices/heartbeat")
async def heartbeat(admin: Admin, actor: Actor):
    return {"devices": await rpc(admin, "device_heartbeat", {"p_actor": str(actor)})}
