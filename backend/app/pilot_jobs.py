import asyncio
import os
import re
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, model_validator

from .accounts import Client, Token, call

router = APIRouter(prefix="/api")
MIB = 1024 * 1024
INPUTS = "grove-job-inputs"
RESULTS = "grove-pilot-results"


class InputFile(BaseModel):
    name: str = Field(pattern=r"^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$")
    size: int = Field(ge=0, le=16 * MIB)


class Submission(BaseModel):
    id: UUID
    device_id: UUID
    name: str = Field(min_length=1, max_length=120)
    cpus: int = Field(ge=1, le=64)
    memory_mib: int = Field(ge=256, le=65536)
    seconds: int = Field(ge=1, le=900)
    files: list[InputFile] = Field(min_length=1, max_length=9)

    @model_validator(mode="after")
    def validate_files(self):
        names = {f.name.lower() for f in self.files}
        if (not self.name.strip() or self.files[0].name != "main.py" or not self.files[0].size
            or len(names) != len(self.files) or sum(f.size for f in self.files) > 16 * MIB
            or any(n.endswith(".") or re.fullmatch(r"(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?", n) for n in names)):
            raise ValueError("Invalid job files.")
        return self


def admin_headers():
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not key:
        raise HTTPException(503, "Job file transfers are not configured.")
    headers = {"apikey": key}
    if not key.startswith("sb_secret_"):
        headers["Authorization"] = "Bearer " + key
    return headers


async def rpc(client, name, arguments):
    return await call(client, "POST", "/rest/v1/rpc/" + name, headers=admin_headers(), json=arguments)


async def signed(client, bucket, path, upload=False):
    op = "upload/sign" if upload else "sign"
    data = await call(client, "POST", f"/storage/v1/object/{op}/{bucket}/{path}",
                      headers=admin_headers(), json={} if upload else {"expiresIn": 300})
    relative = data["url" if upload else "signedURL"]
    if not relative.startswith("/object/"):
        raise HTTPException(502, "Storage returned an invalid transfer link.")
    return str(client.base_url).rstrip("/") + "/storage/v1" + relative


@router.post("/jobs/stage")
async def stage(payload: Submission, client: Client, token: Token):
    owner = await call(client, "GET", "/auth/v1/user", token=token)
    files = [f.model_dump() for f in payload.files]
    ok = await rpc(client, "stage_job", {"p_id": str(payload.id), "p_owner": owner["id"],
        "p_device": str(payload.device_id), "p_name": payload.name.strip(), "p_cpus": payload.cpus,
        "p_memory": payload.memory_mib, "p_seconds": payload.seconds, "p_files": files})
    if not ok:
        raise HTTPException(409, "Check the device ID, online status and sharing limits.")
    urls = await asyncio.gather(*(signed(client, INPUTS, f"{payload.id}/{f.name}", True) for f in payload.files))
    return {"uploads": urls}


@router.post("/jobs/{job_id}/submit")
async def submit(job_id: UUID, client: Client, token: Token):
    owner = await call(client, "GET", "/auth/v1/user", token=token)
    if not await rpc(client, "submit_job", {"p_id": str(job_id), "p_owner": owner["id"]}):
        raise HTTPException(409, "The upload is incomplete or expired.")
    return {"ok": True}


@router.post("/jobs/{job_id}/withdraw")
async def withdraw(job_id: UUID, client: Client, token: Token):
    if not await call(client, "POST", "/rest/v1/rpc/cancel_job_request", token=token, json={"p_id": str(job_id)}):
        raise HTTPException(409, "This request can no longer be withdrawn.")
    return {"ok": True}


async def result_path(job_id, client, token):
    return await call(client, "POST", "/rest/v1/rpc/pilot_result_path", token=token, json={"p_id": str(job_id)})


@router.get("/jobs/{job_id}/download")
async def download(job_id: UUID, client: Client, token: Token):
    path = await result_path(job_id, client, token)
    if path:
        return {"url": await signed(client, RESULTS, path) + "&download=result.zip"}
    rows = await call(client, "GET", "/rest/v1/compute_jobs", token=token, params={
        "id": f"eq.{job_id}", "status": "in.(completed,failed,cancelled)", "select": "result_filename"})
    if not rows or not rows[0]["result_filename"]:
        raise HTTPException(404, "Result unavailable.")
    data = await call(client, "POST", f"/storage/v1/object/sign/grove-job-results/{job_id}/result",
                      token=token, json={"expiresIn": 300})
    return {"url": str(client.base_url).rstrip("/") + "/storage/v1" + data["signedURL"]
            + "&download=" + quote(rows[0]["result_filename"], safe="")}


class DeviceAction(BaseModel):
    action: Literal["offers", "accept", "decline", "inputs", "running", "upload", "complete", "cancel", "fail"]
    job: UUID | None = None
    attempt: UUID | None = None
    detail: str = Field(default="", max_length=300)


@router.post("/hosts/work")
async def work(payload: DeviceAction, client: Client, authorization: Annotated[str, Header()] = ""):
    if not re.fullmatch(r"Bearer [0-9]{10}\.[a-f0-9]{64}", authorization):
        raise HTTPException(401, "Device credential required.")
    job, attempt = payload.job, payload.attempt
    value = await rpc(client, "device_job", {"p_secret": authorization[7:], "p_action": payload.action,
        "p_id": str(job) if job else None, "p_attempt": str(attempt) if attempt else None, "p_detail": payload.detail})
    if value is None:
        raise HTTPException(409, "This device or claim is no longer eligible.")
    if payload.action == "inputs":
        urls = await asyncio.gather(*(signed(client, INPUTS, f"{job}/{f['name']}") for f in value["files"]))
        for f, url in zip(value["files"], urls):
            f["url"] = url
    if payload.action == "upload":
        return {"url": await signed(client, RESULTS, f"{job}/{attempt}/result.zip", True)}
    return value
