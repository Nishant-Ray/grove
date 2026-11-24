from typing import Annotated, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import RedirectResponse, StreamingResponse

from .pilot_jobs import RESULTS, result_path, signed
from .accounts import Client, Token, call

router = APIRouter(prefix="/api/jobs")
COLUMNS = "id,name,status,progress,requested_at,scheduled_at,started_at,finished_at,result_summary,result_filename"
GROUPS = {
    "requests": "eq.requested",
    "active": "in.(scheduled,running)",
    "history": "in.(completed,failed,cancelled)",
}


@router.get("")
async def list_jobs(client: Client, token: Token, group: Literal["requests", "active", "history"] = "active",
                    offset: Annotated[int, Query(ge=0)] = 0):
    await call(client, "POST", "/rest/v1/rpc/refresh_my_jobs", token=token, json={})
    rows = await call(client, "GET", "/rest/v1/compute_jobs", token=token, params={
        "select": COLUMNS, "status": GROUPS[group], "order": "requested_at.desc,id.desc",
        "limit": 21, "offset": offset,
    })
    return {"jobs": rows[:20], "has_more": len(rows) > 20}


@router.get("/{job_id}/result")
async def download_result(job_id: UUID, client: Client, token: Token):
    # Storage applies the job ownership and terminal-state policy on every read.
    rows = await call(client, "GET", "/rest/v1/compute_jobs", token=token, params={
        "id": f"eq.{job_id}", "status": GROUPS["history"], "select": "result_filename",
    })
    if not rows or not rows[0]["result_filename"]:
        raise HTTPException(404, "Result unavailable.")
    if rows[0]["result_filename"] == "result.zip":
        pilot_path = await result_path(job_id, client, token)
        if pilot_path:
            return RedirectResponse(await signed(client, RESULTS, pilot_path) + "&download=result.zip", status_code=303)
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
