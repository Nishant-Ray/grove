"""Credits (Stripe Checkout top-ups), host payouts (Stripe Connect Express) and the Stripe webhook.

Money rules live in the database (see migrations/*_credits.sql); this module only talks to Stripe and
calls service-role database functions with an actor verified by current_user().
"""
import os
import re
from decimal import Decimal
from typing import Annotated
from uuid import UUID

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .accounts import Actor, Admin, Client, Token, call, rpc, setting

router = APIRouter(prefix="/api")
MICROS_PER_CENT = 10_000
SESSION_ID = r"^cs_(test|live)_[A-Za-z0-9]{10,200}$"
PURPOSE = "grove_credits"


def web_url() -> str:
    return setting("GROVE_WEB_URL", "http://127.0.0.1:5173").rstrip("/")


async def stripe_client():
    key = setting("STRIPE_SECRET_KEY")
    if not key:
        raise HTTPException(503, "Payments are not configured.")
    return stripe.StripeClient(key, max_network_retries=2)


Stripe = Annotated[stripe.StripeClient, Depends(stripe_client)]


async def stripe_call(fn, *args, **kwargs):
    """Run a blocking Stripe SDK call off the event loop and translate its errors."""
    try:
        return await run_in_threadpool(fn, *args, **kwargs)
    except stripe.StripeError as error:
        message = getattr(error, "user_message", None) or str(error)
        if "signed up for Connect" in message:
            raise HTTPException(503, "Payouts aren't available yet: Grove's Stripe account needs Connect enabled.") from None
        raise HTTPException(502, "Stripe could not complete the request. Please try again.") from None


async def settings(client) -> dict:
    rows = await call(client, "GET", "/rest/v1/grove_settings",
                      params={"select": "min_topup_usd,max_topup_usd,min_withdrawal_usd"})
    if not rows:
        raise HTTPException(503, "Payments are not configured.")
    return rows[0]


# Wallet ------------------------------------------------------------------------------------------
@router.get("/wallet")
async def wallet(client: Client, token: Token):
    rows = await call(client, "GET", "/rest/v1/wallets", token=token,
                      params={"select": "balance_micros,reserved_micros,earnings_micros"})
    w = rows[0] if rows else {"balance_micros": 0, "reserved_micros": 0, "earnings_micros": 0}
    activity = await call(client, "GET", "/rest/v1/ledger_entries", token=token, params={
        "select": "id,kind,amount_micros,job_id,created_at,job:compute_jobs(name)",
        "order": "created_at.desc,id.desc", "limit": 25,
    })
    account = await call(client, "GET", "/rest/v1/host_accounts", token=token,
                         params={"select": "details_submitted,payouts_enabled"})
    withdrawals = await call(client, "GET", "/rest/v1/withdrawals", token=token, params={
        "select": "id,amount_micros,status,failure,created_at", "order": "created_at.desc", "limit": 10,
    })
    return {
        **w, "available_micros": w["balance_micros"] - w["reserved_micros"],
        "activity": activity, "payouts": account[0] if account else None,
        "withdrawals": withdrawals, "limits": await settings(client),
    }


# Top-ups -----------------------------------------------------------------------------------------
class TopUp(BaseModel):
    amount_usd: int = Field(gt=0)


@router.post("/wallet/checkout")
async def create_checkout(payload: TopUp, client: Client, token: Token, stripe_api: Stripe):
    limits = await settings(client)
    low, high = int(Decimal(str(limits["min_topup_usd"]))), int(Decimal(str(limits["max_topup_usd"])))
    if not low <= payload.amount_usd <= high:
        raise HTTPException(422, f"Top up between ${low} and ${high}.")
    user = await call(client, "GET", "/auth/v1/user", token=token)
    metadata = {"user_id": user["id"], "purpose": PURPOSE}
    session = await stripe_call(stripe_api.v1.checkout.sessions.create, params={
        "mode": "payment",
        "line_items": [{"quantity": 1, "price_data": {
            "currency": "usd", "unit_amount": payload.amount_usd * 100,
            "product_data": {"name": "Grove compute credits",
                             "description": f"${payload.amount_usd} of prepaid compute credits"},
        }}],
        "customer_email": user["email"],
        "client_reference_id": user["id"],
        "metadata": metadata,
        "payment_intent_data": {"metadata": metadata, "description": "Grove compute credits"},
        "success_url": web_url() + "/?checkout=success&session_id={CHECKOUT_SESSION_ID}#wallet",
        "cancel_url": web_url() + "/?checkout=cancelled#wallet",
    })
    return {"url": session["url"]}


async def apply_paid_session(admin, session, expected_user: UUID | None = None) -> bool:
    """Credit a paid Grove Checkout session once. Returns True if this call added the credits."""
    metadata = session.get("metadata") or {}
    user_id = metadata.get("user_id", "")
    if metadata.get("purpose") != PURPOSE or not re.fullmatch(r"[0-9a-f-]{36}", user_id or ""):
        return False  # not a Grove top-up
    if expected_user is not None and user_id != str(expected_user):
        raise HTTPException(404, "Checkout session not found.")
    if session.get("payment_status") != "paid" or session.get("currency") != "usd" or not session.get("amount_total"):
        return False
    return bool(await rpc(admin, "credit_topup", {
        "p_user": user_id, "p_session": session["id"],
        "p_amount_micros": session["amount_total"] * MICROS_PER_CENT,
    }))


class Confirm(BaseModel):
    session_id: str = Field(pattern=SESSION_ID)


@router.post("/wallet/checkout/confirm")
async def confirm_checkout(payload: Confirm, admin: Admin, actor: Actor, stripe_api: Stripe):
    # The return page credits immediately; the webhook does the same if the user never comes back.
    session = await stripe_call(stripe_api.v1.checkout.sessions.retrieve, payload.session_id)
    credited = await apply_paid_session(admin, session, expected_user=actor)
    return {"credited": credited, "payment_status": session.get("payment_status"),
            "amount_usd": (session.get("amount_total") or 0) / 100}


# Host payouts --------------------------------------------------------------------------------------
async def host_account(client, token) -> str | None:
    rows = await call(client, "GET", "/rest/v1/host_accounts", token=token, params={"select": "stripe_account_id"})
    return rows[0]["stripe_account_id"] if rows else None


def payouts_ready(account) -> bool:
    capabilities = account.get("capabilities") or {}
    return bool(account.get("payouts_enabled")) and capabilities.get("transfers") == "active"


@router.post("/payouts/onboard")
async def onboard(client: Client, token: Token, admin: Admin, actor: Actor, stripe_api: Stripe):
    account_id = await host_account(client, token)
    if not account_id:
        user = await call(client, "GET", "/auth/v1/user", token=token)
        account = await stripe_call(stripe_api.v1.accounts.create, params={
            "type": "express", "country": "US", "email": user["email"], "business_type": "individual",
            "capabilities": {"transfers": {"requested": True}}, "metadata": {"user_id": str(actor)},
        }, options={"idempotency_key": f"grove-host-account-{actor}"})
        account_id = account["id"]
        await rpc(admin, "save_host_account", {"p_actor": str(actor), "p_account": account_id})
    link = await stripe_call(stripe_api.v1.account_links.create, params={
        "account": account_id, "type": "account_onboarding",
        "refresh_url": web_url() + "/?payouts=refresh#wallet",
        "return_url": web_url() + "/?payouts=return#wallet",
    })
    return {"url": link["url"]}


@router.post("/payouts/refresh")
async def refresh_payouts(client: Client, token: Token, admin: Admin, stripe_api: Stripe):
    account_id = await host_account(client, token)
    if not account_id:
        return {"payouts_enabled": False, "details_submitted": False}
    account = await stripe_call(stripe_api.v1.accounts.retrieve, account_id)
    status = {"details_submitted": bool(account.get("details_submitted")), "payouts_enabled": payouts_ready(account)}
    await rpc(admin, "sync_host_account", {"p_account": account_id, "p_details": status["details_submitted"],
                                           "p_payouts": status["payouts_enabled"]})
    return status


class Withdraw(BaseModel):
    amount_usd: Decimal = Field(gt=0, le=100000, decimal_places=2)


@router.post("/payouts/withdraw")
async def withdraw(payload: Withdraw, admin: Admin, actor: Actor, stripe_api: Stripe):
    micros = int(payload.amount_usd * 1_000_000)
    rows = await rpc(admin, "request_withdrawal", {"p_actor": str(actor), "p_amount_micros": micros})
    withdrawal_id, destination = rows[0]["withdrawal_id"], rows[0]["stripe_account_id"]
    try:
        transfer = await run_in_threadpool(stripe_api.v1.transfers.create, params={
            "amount": micros // MICROS_PER_CENT, "currency": "usd", "destination": destination,
            "description": "Grove host earnings",
            "metadata": {"withdrawal_id": withdrawal_id, "user_id": str(actor)},
        }, options={"idempotency_key": f"grove-withdrawal-{withdrawal_id}"})
    except stripe.StripeError as error:
        reason = getattr(error, "code", None) or "stripe_error"
        await rpc(admin, "fail_withdrawal", {"p_id": withdrawal_id, "p_reason": reason})
        raise HTTPException(502, "Stripe couldn't send this payout, so your earnings were returned. "
                                 "Please try again later.") from None
    await rpc(admin, "complete_withdrawal", {"p_id": withdrawal_id, "p_transfer": transfer["id"]})
    return {"id": withdrawal_id, "status": "paid", "amount_usd": str(payload.amount_usd)}


# Webhook -----------------------------------------------------------------------------------------
@router.post("/stripe/webhook")
async def stripe_webhook(request: Request, admin: Admin):
    secret = setting("STRIPE_WEBHOOK_SECRET")
    if not secret:
        raise HTTPException(503, "Webhook is not configured.")
    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(payload, request.headers.get("stripe-signature", ""), secret)
    except (ValueError, stripe.SignatureVerificationError):
        raise HTTPException(400, "Invalid signature.") from None
    kind, obj = event["type"], event["data"]["object"]
    # Handlers are idempotent, so the event is recorded only after it was processed successfully;
    # a failure returns 5xx and Stripe retries.
    if kind in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        await apply_paid_session(admin, obj)
    elif kind == "account.updated":
        await rpc(admin, "sync_host_account", {"p_account": obj["id"],
                                               "p_details": bool(obj.get("details_submitted")),
                                               "p_payouts": payouts_ready(obj)})
    first = await rpc(admin, "record_stripe_event", {"p_id": event["id"], "p_type": kind})
    return {"received": True, "duplicate": not first}
