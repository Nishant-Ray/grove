from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .accounts import router
from .jobs import router as jobs_router

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
app = FastAPI(title="Grove API")
app.include_router(router)
app.include_router(jobs_router)


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, error: RequestValidationError):
    # Validation errors may include submitted passwords in their input field.
    return JSONResponse({"detail": "Please check the entries and try again."}, status_code=422)


@app.middleware("http")
async def protect_account_requests(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        # Browser cross-origin forms cannot attach this header. The API uses
        # a same-origin proxy and does not grant cross-origin CORS access.
        if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("X-Grove-Request") != "1":
            return JSONResponse({"detail": "Missing request header."}, status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "private, no-store"
        return response
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
