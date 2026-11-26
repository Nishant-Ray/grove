from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, StringConstraints

from .accounts import Actor, Admin, Client, Token, call, rpc
from .quotes import SLUG, device_price

router = APIRouter(prefix="/api/jobs")
COLUMNS = ("id,name,status,progress,requested_at,scheduled_at,started_at,finished_at,result_summary,"
           "result_filename,host_device_id,gpu_model,priority,est_hours,rate_per_hr,host_payout_per_hr,"
           "reserve_micros,charged_micros,code_link,accepted_at,start_by,outcome_reason")
GROUPS = {
    "requests": "eq.requested",
    "active": "in.(scheduled,running)",
    "history": "in.(completed,failed,cancelled,declined)",
}
RESULT_STATES = "in.(completed,failed,cancelled)"


@router.get("")
async def list_jobs(client: Client, token: Token, actor: Actor,
                    group: Literal["requests", "active", "history"] = "active",
                    role: Literal["renter", "host"] = "renter",
                    offset: Annotated[int, Query(ge=0)] = 0):
    rows = await call(client, "GET", "/rest/v1/compute_jobs", token=token, params={
        "select": COLUMNS, "status": GROUPS[group], "order": "requested_at.desc,id.desc",
        "owner_id" if role == "renter" else "host_id": f"eq.{actor}",
        "limit": 21, "offset": offset,
    })
    return {"jobs": rows[:20], "has_more": len(rows) > 20}


class JobRequest(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    host_device_id: UUID
    priority: Annotated[str, StringConstraints(pattern=SLUG)]
    hours: Decimal = Field(ge=Decimal("0.01"), le=168, decimal_places=2)
    min_vram_gb: int = Field(default=0, ge=0, le=1024)
    code_link: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000,
                                                pattern=r"^(https?://\S+)?$")] = ""


@router.post("", status_code=201)
async def create_job(payload: JobRequest, client: Client, token: Token, admin: Admin, actor: Actor):
    # Re-quote on the server: prices are never taken from the client.
    _, p = await device_price(client, token, payload.host_device_id, payload.priority, payload.hours)
    if not p["clears_floor"]:
        raise HTTPException(409, "This host can't take jobs at the current price. Choose another host.")
    return await rpc(admin, "create_job", {
        "p_actor": str(actor), "p_device_id": str(payload.host_device_id), "p_name": payload.name,
        "p_priority": payload.priority, "p_hours": str(payload.hours), "p_min_vram": payload.min_vram_gb,
        "p_code_link": payload.code_link, "p_rate": str(p["rate"]), "p_payout": str(p["payout"]),
        "p_reserve_micros": p["reserve_micros"],
    })


class ActionDetails(BaseModel):
    summary: str = Field(default="", max_length=1000)


@router.post("/{job_id}/{action}")
async def job_action(job_id: UUID, action: Literal["accept", "decline", "start", "complete", "fail_host",
                                                   "fail_job", "stop", "cancel"],
                     admin: Admin, actor: Actor, details: Annotated[ActionDetails | None, Body()] = None):
    return await rpc(admin, "job_action", {
        "p_actor": str(actor), "p_job_id": str(job_id), "p_action": action,
        "p_summary": details.summary if details else None,
    })


@router.get("/{job_id}/result")
async def download_result(job_id: UUID, client: Client, token: Token):
    # Storage applies the job ownership and terminal-state policy on every read.
    rows = await call(client, "GET", "/rest/v1/compute_jobs", token=token, params={
        "id": f"eq.{job_id}", "status": RESULT_STATES, "select": "result_filename",
    })
    if not rows or not rows[0]["result_filename"]:
        raise HTTPException(404, "Result unavailable.")
    path = f"/storage/v1/object/authenticated/grove-job-results/{job_id}/result"
    request = client.build_request("GET", path, headers={"Authorization": f"Bearer {token}"})
    try:
        upstream = await client.send(request, stream=True)
    except httpx.RequestError:
        raise HTTPException(503, "Result storage is unavailable.") from None
    if upstream.is_error:
        await upstream.aclose()
        raise HTTPException(404 if upstream.status_code in (400, 403, 404) else 503, "Result unavailable.")

    async def chunks():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(chunks(), media_type="application/octet-stream",
                             headers={"Content-Disposition": 'attachment; filename="result"'})
