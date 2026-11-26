"""Job detail and renter-host messaging. All reads and writes use the signed-in user's JWT;
row-level security limits threads to the job's renter and host after acceptance."""
from datetime import datetime, timedelta, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, StringConstraints

from .accounts import Actor, Client, Token, call
from .jobs import COLUMNS as JOB_COLUMNS

# Registered before the jobs router so /{job_id}/messages is not taken for a job action.
router = APIRouter(prefix="/api/jobs")
MESSAGES = "/rest/v1/messages"
CLOSED = "Messaging isn't open for this job. It opens once the host accepts and closes 14 days after the job ends."


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.get("/{job_id}")
async def job_detail(job_id: UUID, client: Client, token: Token):
    rows = await call(client, "GET", "/rest/v1/compute_jobs", token=token,
                      params={"id": f"eq.{job_id}", "select": JOB_COLUMNS})
    people = await call(client, "POST", "/rest/v1/rpc/job_participants", token=token,
                        json={"p_job": str(job_id)})
    if not rows or not people:
        raise HTTPException(404, "Job could not be found.")
    job = rows[0]
    can_send = False
    if job["accepted_at"]:
        can_send = await call(client, "POST", "/rest/v1/rpc/job_thread_open", token=token,
                              json={"p_job": str(job_id)})
    role = people[0]["role"]
    reviews = await call(client, "GET", "/rest/v1/reviews", token=token, params={
        "job_id": f"eq.{job_id}", "select": "reviewer_role,rating,comment,created_at"})
    mine = next((r for r in reviews if r["reviewer_role"] == role), None)
    theirs = next((r for r in reviews if r["reviewer_role"] != role), None)
    finished = job.get("finished_at")
    in_window = bool(finished) and datetime.fromisoformat(finished) > datetime.now(timezone.utc) - timedelta(days=14)
    return {"job": job, **people[0],
            "messaging": {"visible": job["accepted_at"] is not None, "can_send": bool(can_send)},
            "reviews": {"mine": mine, "theirs": theirs,
                        "can_review": job["status"] == "completed" and in_window and mine is None}}


@router.get("/{job_id}/messages")
async def list_messages(job_id: UUID, client: Client, token: Token, actor: Actor,
                        after: datetime | None = None,
                        limit: Annotated[int, Query(ge=1, le=200)] = 200):
    params = {"job_id": f"eq.{job_id}", "select": "id,sender_id,body,created_at",
              "order": "created_at,id", "limit": limit}
    if after:
        # Inclusive, so messages sharing a timestamp are never skipped; clients dedupe by id.
        params["created_at"] = f"gte.{after.isoformat()}"
    rows = await call(client, "GET", MESSAGES, token=token, params=params)
    return {"messages": [{"id": r["id"], "body": r["body"], "created_at": r["created_at"],
                          "mine": r["sender_id"] == str(actor)} for r in rows]}


class NewMessage(BaseModel):
    body: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


@router.post("/{job_id}/messages", status_code=201)
async def send_message(job_id: UUID, payload: NewMessage, client: Client, token: Token):
    try:
        rows = await call(client, "POST", MESSAGES, token=token, params={"select": "id,body,created_at"},
                          headers={"Prefer": "return=representation"},
                          json={"job_id": str(job_id), "body": payload.body})
    except HTTPException as exc:
        if exc.status_code in (401, 403):  # row-level security: not a participant, or thread closed
            raise HTTPException(403, CLOSED) from None
        raise
    return {**rows[0], "mine": True}


@router.post("/{job_id}/messages/read")
async def mark_thread_read(job_id: UUID, client: Client, token: Token):
    now = utc_now()
    try:
        await call(client, "POST", "/rest/v1/message_reads", token=token,
                   params={"on_conflict": "job_id,user_id"},
                   headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                   json={"job_id": str(job_id), "last_read_at": now})
    except HTTPException as exc:
        if exc.status_code in (401, 403):
            raise HTTPException(404, "Job could not be found.") from None
        raise
    await call(client, "PATCH", "/rest/v1/notifications", token=token,
               params={"job_id": f"eq.{job_id}", "kind": "eq.new_message", "read_at": "is.null"},
               json={"read_at": now})
    return {"ok": True}
