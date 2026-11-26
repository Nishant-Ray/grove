"""In-app notifications. Rows are created by database triggers; users can only list their own
and mark them read (row-level security plus a read_at-only column grant)."""
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from .accounts import Client, Token, call

router = APIRouter(prefix="/api/notifications")
TABLE = "/rest/v1/notifications"
COLUMNS = "id,kind,job_id,title,body,created_at,read_at"
UNREAD_CAP = 99


@router.get("")
async def list_notifications(client: Client, token: Token,
                             limit: Annotated[int, Query(ge=1, le=50)] = 20,
                             unread_only: bool = False):
    params = {"select": COLUMNS, "order": "created_at.desc,id.desc", "limit": limit}
    if unread_only:
        params["read_at"] = "is.null"
    rows = await call(client, "GET", TABLE, token=token, params=params)
    unread = await call(client, "GET", TABLE, token=token,
                        params={"select": "id", "read_at": "is.null", "limit": UNREAD_CAP + 1})
    return {"notifications": rows, "unread": min(len(unread), UNREAD_CAP),
            "unread_more": len(unread) > UNREAD_CAP}


class MarkRead(BaseModel):
    # Omit ids to mark everything read.
    ids: list[UUID] | None = Field(default=None, max_length=100)


@router.post("/read")
async def mark_read(payload: MarkRead, client: Client, token: Token):
    params = {"read_at": "is.null"}
    if payload.ids is not None:
        if not payload.ids:
            return {"ok": True}
        params["id"] = "in.(" + ",".join(str(i) for i in payload.ids) + ")"
    await call(client, "PATCH", TABLE, token=token, params=params,
               json={"read_at": datetime.now(timezone.utc).isoformat()})
    return {"ok": True}
