from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from .accounts import Client, Token, call

router = APIRouter(prefix="/api/hosts")


class Approval(BaseModel):
    device_id: UUID
    fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    expires: int = Field(gt=0, lt=4102444800)


class Limits(BaseModel):
    cpus: int = Field(ge=1, le=4096)
    memory_mib: int = Field(ge=256, le=67108864)


class Capabilities(BaseModel):
    os: str = Field(max_length=64)
    arch: str = Field(max_length=64)
    engine_arch: str = Field(max_length=64)
    cpus: int = Field(ge=0, le=4096)
    memory_mib: int = Field(ge=0, le=67108864)
    disk_mib: int = Field(ge=0)
    runtime: Literal["ready", "unavailable"]
    checksum_verified: bool
    agent_version: str = Field(max_length=32)


class Pulse(BaseModel):
    online: bool
    capabilities: Capabilities
    limits: Limits


@router.post("/approve")
async def approve(payload: Approval, client: Client, token: Token):
    accepted = await call(client, "POST", "/rest/v1/rpc/approve_host", token=token, json={
        "p_device": str(payload.device_id), "p_hash": payload.fingerprint, "p_expires": payload.expires})
    if not accepted:
        raise HTTPException(409, "Pairing expired or the listing is already linked. Start a new link.")
    return {"ok": True}


@router.get("")
async def installations(client: Client, token: Token):
    return await call(client, "POST", "/rest/v1/rpc/host_status", token=token, json={})


@router.delete("/{installation_id}")
async def revoke(installation_id: UUID, client: Client, token: Token):
    ok = await call(client, "POST", "/rest/v1/rpc/revoke_host", token=token, json={"p_id": str(installation_id)})
    if not ok:
        raise HTTPException(404, "Installation not found.")
    return {"ok": True}


@router.post("/heartbeat")
async def heartbeat(payload: Pulse, client: Client, authorization: Annotated[str, Header()] = ""):
    scheme, _, secret = authorization.partition(" ")
    if scheme != "Bearer" or not 64 <= len(secret) <= 100:
        raise HTTPException(401, "Device credential required.")
    caps, limits = payload.capabilities, payload.limits
    if payload.online and (not caps.checksum_verified or caps.runtime != "ready" or limits.cpus > caps.cpus or limits.memory_mib > caps.memory_mib):
        raise HTTPException(422, "Sharing limits exceed available capacity.")
    name = await call(client, "POST", "/rest/v1/rpc/host_pulse", json={
        "p_secret": secret, "p_online": payload.online, "p_caps": caps.model_dump(), "p_limits": limits.model_dump()})
    if not name:
        raise HTTPException(401, "Pairing pending, expired, or revoked.", headers={"X-Grove-Device": "unlinked"})
    return {"device": name}
