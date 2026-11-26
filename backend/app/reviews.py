"""Reviews and public profiles. Reviews are written with the user's JWT; the database derives who is
reviewed and enforces that only participants of a completed job can review, once, within 14 days."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from .accounts import Client, Token, call

# Registered before the jobs router so /{job_id}/review is not taken for a job action.
router = APIRouter(prefix="/api")


class NewReview(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] = ""


@router.post("/jobs/{job_id}/review", status_code=201)
async def review_job(job_id: UUID, payload: NewReview, client: Client, token: Token):
    try:
        rows = await call(client, "POST", "/rest/v1/reviews", token=token,
                          params={"select": "id,reviewer_role,rating,comment,created_at"},
                          headers={"Prefer": "return=representation"},
                          json={"job_id": str(job_id), "rating": payload.rating, "comment": payload.comment})
    except HTTPException as exc:
        if exc.status_code == 409:
            raise HTTPException(409, "You already reviewed this job.") from None
        if exc.status_code in (401, 403):
            raise HTTPException(403, "You can review a job you took part in for 14 days after it completes.") from None
        raise
    return rows[0]


@router.get("/users/{user_id}/profile")
async def profile(user_id: UUID, client: Client, token: Token):
    rows = await call(client, "POST", "/rest/v1/rpc/reputation", token=token, json={"p_users": [str(user_id)]})
    if not rows:
        raise HTTPException(404, "Member not found.")
    reviews = await call(client, "POST", "/rest/v1/rpc/reviews_received", token=token,
                         json={"p_user": str(user_id), "p_limit": 20})
    r = rows[0]
    return {
        "id": str(user_id),
        "display_name": r["display_name"] or "Grove member",
        "host": {"rating": r["host_rating"], "reviews": r["host_reviews"], "jobs_completed": r["jobs_completed"],
                 "completion_rate": r["completion_rate"]},
        "renter": {"rating": r["renter_rating"], "reviews": r["renter_reviews"]},
        # Reviewers' job ids stay private; profiles show what was said, by whom and when.
        "reviews": [{k: v for k, v in review.items() if k != "job_id"} for review in reviews],
    }
