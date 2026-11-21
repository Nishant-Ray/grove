"""Authentication and account data, accessed using the signed-in user's privileges."""
import os
import secrets
from hashlib import sha256
from base64 import urlsafe_b64encode
from typing import Annotated, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field, SecretStr, StringConstraints
from fastapi.responses import RedirectResponse

router = APIRouter(prefix="/api")
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
ACCESS = "grove_access"
REFRESH = "grove_refresh"


async def upstream():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_PUBLISHABLE_KEY")
    if not url or not key:
        raise HTTPException(503, "Account services are not configured.")
    async with httpx.AsyncClient(base_url=url.rstrip("/"), headers={"apikey": key}, timeout=12) as client:
        yield client


Client = Annotated[httpx.AsyncClient, Depends(upstream)]


async def call(client, method, path, *, token=None, headers=None, **kwargs):
    headers = dict(headers or {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        result = await client.request(method, path, headers=headers, **kwargs)
    except httpx.RequestError:
        raise HTTPException(503, "Account services are temporarily unavailable.") from None
    if result.is_error:
        if result.status_code >= 500:
            raise HTTPException(503, "Account services are temporarily unavailable.")
        detail = "The request could not be completed."
        if path.startswith("/auth/"):
            data = result.json()
            if token and data.get("error_code") in {"bad_jwt", "session_expired", "session_not_found", "user_not_found"}:
                raise HTTPException(401, "Please log in again.")
            detail = data.get("msg") or data.get("error_description") or detail
        raise HTTPException(result.status_code, detail)
    return result.json() if result.content else None


def access(request: Request) -> str:
    token = request.cookies.get(ACCESS)
    if not token:
        raise HTTPException(401, "Please log in.")
    return token


Token = Annotated[str, Depends(access)]


class Credentials(BaseModel):
    email: EmailStr
    password: SecretStr = Field(min_length=1, max_length=256)


class Signup(Credentials):
    display_name: Text
    password: SecretStr = Field(min_length=8, max_length=256)


class Profile(BaseModel):
    display_name: Text
    bio: str = Field(default="", max_length=400)


class WorkspacePreference(BaseModel):
    mode: Literal["new", "rent", "host", "host_setup"]


class DeviceSpecs(BaseModel):
    cpu: Text
    ram_gb: int = Field(gt=0, le=65536)
    gpu: Text | None = None
    vram_gb: int | None = Field(default=None, gt=0, le=65536)
    os: Literal["Linux", "Windows", "macOS", "Other"]
    storage_gb: int | None = Field(default=None, gt=0, le=10000000)
    hosting_hours: str = Field(default="", max_length=200)
    acceptance: Literal["manual", "automatic"] = "manual"


class Device(BaseModel):
    name: Text
    hardware: Text
    specs: DeviceSpecs | None = None
    availability: Literal["available", "paused"] = "paused"


def account(user):
    metadata = user.get("user_metadata") or {}
    mode = metadata.get("workspace_mode", "rent")
    return {"workspace_mode": mode if mode in ("new", "rent", "host_setup", "host") else "rent",
            "email": user["email"], "display_name": metadata.get("display_name") or "",
            "bio": metadata.get("bio") or ""}


def secure_cookies():
    return os.getenv("GROVE_COOKIE_SECURE", "true").lower() != "false"


def session(response, data):
    for name, value, age in ((ACCESS, data["access_token"], data["expires_in"]),
                             (REFRESH, data["refresh_token"], 30 * 86400)):
        response.set_cookie(name, value, max_age=age, path="/api", httponly=True,
                            secure=secure_cookies(), samesite="lax")


@router.post("/auth/register")
async def register(payload: Signup, response: Response, client: Client):
    verifier = secrets.token_urlsafe(48)
    challenge = urlsafe_b64encode(sha256(verifier.encode()).digest()).decode().rstrip("=")
    web_url = os.getenv("GROVE_WEB_URL", "http://127.0.0.1:5173").rstrip("/")
    data = await call(client, "POST", "/auth/v1/signup",
                      params={"redirect_to": web_url + "/api/auth/confirm"}, json={
        "email": str(payload.email), "password": payload.password.get_secret_value(),
        "data": {"display_name": payload.display_name, "workspace_mode": "new"}, "code_challenge": challenge,
        "code_challenge_method": "s256",
    })
    if data.get("access_token"):
        session(response, data)
        return {"user": account(data["user"])}
    response.set_cookie("grove_verifier", verifier, max_age=3600, path="/api/auth/confirm",
                        httponly=True, secure=secure_cookies(), samesite="lax")
    return {"user": None}


@router.get("/auth/confirm")
async def confirm(request: Request, client: Client, code: str = ""):
    # Cross-device and expired-verifier confirmations fall back to password login.
    response = RedirectResponse("/#login", status_code=303)
    verifier = request.cookies.get("grove_verifier")
    if verifier and code:
        try:
            data = await call(client, "POST", "/auth/v1/token", params={"grant_type": "pkce"},
                              json={"auth_code": code, "code_verifier": verifier})
        except HTTPException as exc:
            if exc.status_code not in (400, 401, 403, 422):
                raise
        else:
            response = RedirectResponse("/#account", status_code=303)
            session(response, data)
    response.delete_cookie("grove_verifier", path="/api/auth/confirm")
    return response


@router.post("/auth/login")
async def login(payload: Credentials, response: Response, client: Client):
    data = await call(client, "POST", "/auth/v1/token", params={"grant_type": "password"},
                      json={"email": str(payload.email), "password": payload.password.get_secret_value()})
    session(response, data)
    return {"user": account(data["user"])}


@router.post("/auth/refresh")
async def refresh(request: Request, response: Response, client: Client):
    token = request.cookies.get(REFRESH)
    if not token:
        raise HTTPException(401, "Please log in.")
    try:
        data = await call(client, "POST", "/auth/v1/token", params={"grant_type": "refresh_token"},
                          json={"refresh_token": token})
    except HTTPException as exc:
        if exc.status_code in (400, 401, 403):
            raise HTTPException(401, "Please log in again.") from None
        raise
    session(response, data)
    return {"user": account(data["user"])}


@router.post("/auth/logout")
async def logout(response: Response, client: Client, token: Token):
    await call(client, "POST", "/auth/v1/logout", params={"scope": "local"}, token=token)
    for name in (ACCESS, REFRESH):
        response.delete_cookie(name, path="/api")
    return {"ok": True}


@router.get("/profile")
async def profile(client: Client, token: Token):
    return account(await call(client, "GET", "/auth/v1/user", token=token))


@router.put("/profile")
async def update_profile(payload: Profile, client: Client, token: Token):
    return account(await call(client, "PUT", "/auth/v1/user", token=token,
                              json={"data": payload.model_dump()}))


@router.put("/profile/preference")
async def preference(payload: WorkspacePreference, client: Client, token: Token):
    return account(await call(client, "PUT", "/auth/v1/user", token=token,
                              json={"data": {"workspace_mode": payload.mode}}))


DEVICES = "/rest/v1/host_devices"
COLUMNS = "id,name,hardware,availability,specs"


@router.get("/devices")
async def devices(client: Client, token: Token):
    return await call(client, "GET", DEVICES, token=token, params={"select": COLUMNS, "order": "created_at,id"})


@router.post("/devices", status_code=201)
async def add_device(payload: Device, client: Client, token: Token):
    rows = await call(client, "POST", DEVICES, token=token, params={"select": COLUMNS},
                      headers={"Prefer": "return=representation"}, json=payload.model_dump(exclude_unset=True))
    return rows[0]


@router.put("/devices/{device_id}")
async def edit_device(device_id: UUID, payload: Device, client: Client, token: Token):
    rows = await call(client, "PATCH", DEVICES, token=token, params={"id": f"eq.{device_id}", "select": COLUMNS},
                      headers={"Prefer": "return=representation"}, json=payload.model_dump(exclude_unset=True))
    if not rows:
        raise HTTPException(404, "Device listing could not be found.")
    return rows[0]


@router.delete("/devices/{device_id}")
async def remove_device(device_id: UUID, client: Client, token: Token):
    rows = await call(client, "DELETE", DEVICES, token=token, params={"id": f"eq.{device_id}", "select": "id"},
                      headers={"Prefer": "return=representation"})
    if not rows:
        raise HTTPException(404, "Device listing could not be found.")
    return {"ok": True}
