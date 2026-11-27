"""Payments API with Supabase mocked at the HTTP layer and Stripe replaced by a mock client."""
import hashlib
import hmac
import json
import time
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

import httpx
import stripe
from fastapi.testclient import TestClient

from app.accounts import ACCESS, admin, rpc, upstream
from app.main import app
from app.payments import stripe_client

SECRET = "whsec_test_secret"


def signed(payload: dict, secret=SECRET, timestamp=None):
    body = json.dumps(payload).encode()
    t = int(timestamp or time.time())
    signature = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return body, {"Stripe-Signature": f"t={t},v1={signature}", "Content-Type": "application/json"}


class PaymentsTest(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid4())
        self.calls = []
        self.rpc_results = {"credit_topup": True, "record_stripe_event": True,
                            "request_withdrawal": [{"withdrawal_id": "w-1", "stripe_account_id": "acct_host"}]}
        self.rpc_errors = {}
        self.account_rows = []

        def handler(kind):
            def handle(request):
                body = json.loads(request.content) if request.content else None
                self.calls.append((kind, request.method, request.url.path, body, request))
                path = request.url.path
                if path == "/auth/v1/user":
                    return httpx.Response(200, json={"id": self.user_id, "email": "rae@example.com"})
                if path == "/rest/v1/grove_settings":
                    return httpx.Response(200, json=[{"min_topup_usd": 10, "max_topup_usd": 500, "min_withdrawal_usd": 5}])
                if path == "/rest/v1/wallets":
                    return httpx.Response(200, json=[{"balance_micros": 25000000, "reserved_micros": 887250, "earnings_micros": 0}])
                if path == "/rest/v1/host_accounts":
                    return httpx.Response(200, json=self.account_rows)
                if path.startswith("/rest/v1/rpc/"):
                    name = path.rsplit("/", 1)[1]
                    if name in self.rpc_errors:
                        return httpx.Response(400, json={"code": "P0001", "message": self.rpc_errors[name]})
                    return httpx.Response(200, json=self.rpc_results.get(name))
                return httpx.Response(200, json=[])
            return handle

        def fake(kind):
            async def dependency():
                async with httpx.AsyncClient(base_url="https://test.invalid",
                                             transport=httpx.MockTransport(handler(kind))) as client:
                    yield client
            return dependency

        self.stripe = MagicMock()
        app.dependency_overrides[upstream] = fake("user")
        app.dependency_overrides[admin] = fake("admin")
        app.dependency_overrides[stripe_client] = lambda: self.stripe
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app, headers={"X-Grove-Request": "1"})
        self.addCleanup(self.client.close)
        self.client.cookies.set(ACCESS, "user-token")
        env = patch.dict("os.environ", {"STRIPE_WEBHOOK_SECRET": SECRET, "GROVE_WEB_URL": "https://grove.test"})
        env.start()
        self.addCleanup(env.stop)

    def rpcs(self, name):
        return [c for c in self.calls if c[2] == f"/rest/v1/rpc/{name}"]

    def session(self, **overrides):
        return {"id": "cs_test_abcdefghij", "payment_status": "paid", "currency": "usd", "amount_total": 2500,
                "metadata": {"user_id": self.user_id, "purpose": "grove_credits"}, **overrides}

    # Wallet --------------------------------------------------------------------------------------
    def test_wallet_summary(self):
        body = self.client.get("/api/wallet").json()
        self.assertEqual(body["available_micros"], 25000000 - 887250)
        self.assertEqual(body["limits"]["max_topup_usd"], 500)
        wallet_read = [c for c in self.calls if c[2] == "/rest/v1/wallets"][-1]
        self.assertEqual(wallet_read[4].headers["authorization"], "Bearer user-token")

    # Top-ups -------------------------------------------------------------------------------------
    def test_checkout_amount_limits(self):
        for amount in (0, 5, 501):
            self.assertEqual(self.client.post("/api/wallet/checkout", json={"amount_usd": amount}).status_code, 422)
        self.assertEqual(self.client.post("/api/wallet/checkout", json={"amount_usd": 12.5}).status_code, 422)
        self.stripe.v1.checkout.sessions.create.assert_not_called()

    def test_checkout_session(self):
        self.stripe.v1.checkout.sessions.create.return_value = {"url": "https://checkout.stripe.com/c/pay/cs_test_1"}
        result = self.client.post("/api/wallet/checkout", json={"amount_usd": 25})
        self.assertEqual(result.json(), {"url": "https://checkout.stripe.com/c/pay/cs_test_1"})
        params = self.stripe.v1.checkout.sessions.create.call_args.kwargs["params"]
        self.assertEqual(params["mode"], "payment")
        self.assertEqual(params["line_items"][0]["price_data"]["unit_amount"], 2500)
        self.assertEqual(params["line_items"][0]["price_data"]["currency"], "usd")
        self.assertEqual(params["metadata"], {"user_id": self.user_id, "purpose": "grove_credits"})
        self.assertEqual(params["customer_email"], "rae@example.com")
        self.assertEqual(params["success_url"], "https://grove.test/?checkout=success&session_id={CHECKOUT_SESSION_ID}#wallet")

    def test_confirm_credits_own_paid_session_once(self):
        self.stripe.v1.checkout.sessions.retrieve.return_value = self.session()
        body = self.client.post("/api/wallet/checkout/confirm", json={"session_id": "cs_test_abcdefghij"}).json()
        self.assertEqual(body, {"credited": True, "payment_status": "paid", "amount_usd": 25.0})
        kind, _, _, args, _ = self.rpcs("credit_topup")[-1]
        self.assertEqual(kind, "admin")
        self.assertEqual(args, {"p_user": self.user_id, "p_session": "cs_test_abcdefghij", "p_amount_micros": 25000000})
        self.rpc_results["credit_topup"] = False  # already credited by the webhook
        self.assertFalse(self.client.post("/api/wallet/checkout/confirm", json={"session_id": "cs_test_abcdefghij"}).json()["credited"])

    def test_confirm_rejects_other_users_and_unpaid_sessions(self):
        self.stripe.v1.checkout.sessions.retrieve.return_value = self.session(metadata={"user_id": str(uuid4()), "purpose": "grove_credits"})
        self.assertEqual(self.client.post("/api/wallet/checkout/confirm", json={"session_id": "cs_test_abcdefghij"}).status_code, 404)
        for session in (self.session(payment_status="unpaid"), self.session(currency="eur"),
                        self.session(metadata={"user_id": self.user_id, "purpose": "something_else"})):
            self.stripe.v1.checkout.sessions.retrieve.return_value = session
            self.assertFalse(self.client.post("/api/wallet/checkout/confirm", json={"session_id": "cs_test_abcdefghij"}).json()["credited"])
        self.assertEqual(self.rpcs("credit_topup"), [])
        self.assertEqual(self.client.post("/api/wallet/checkout/confirm", json={"session_id": "pi_123"}).status_code, 422)

    # Webhook -----------------------------------------------------------------------------------------
    def test_webhook_credits_paid_sessions_without_csrf_header(self):
        body, headers = signed({"id": "evt_1", "type": "checkout.session.completed", "data": {"object": self.session()}})
        result = self.client.post("/api/stripe/webhook", content=body, headers={**headers, "X-Grove-Request": ""})
        self.assertEqual(result.json(), {"received": True, "duplicate": False})
        self.assertEqual(self.rpcs("credit_topup")[-1][3]["p_amount_micros"], 25000000)
        self.assertEqual(self.rpcs("record_stripe_event")[-1][3], {"p_id": "evt_1", "p_type": "checkout.session.completed"})

    def test_webhook_rejects_bad_signatures(self):
        body, headers = signed({"id": "evt_1", "type": "checkout.session.completed", "data": {"object": self.session()}},
                               secret="whsec_wrong")
        self.assertEqual(self.client.post("/api/stripe/webhook", content=body, headers=headers).status_code, 400)
        body, headers = signed({"id": "evt_2", "type": "x", "data": {"object": {}}}, timestamp=time.time() - 3600)
        self.assertEqual(self.client.post("/api/stripe/webhook", content=body, headers=headers).status_code, 400)
        self.assertEqual(self.client.post("/api/stripe/webhook", content=b"{}").status_code, 400)
        self.assertEqual(self.rpcs("credit_topup"), [])
        with patch.dict("os.environ", {"STRIPE_WEBHOOK_SECRET": ""}):
            self.assertEqual(self.client.post("/api/stripe/webhook", content=body, headers=headers).status_code, 503)

    def test_webhook_failure_is_retried_not_recorded(self):
        self.rpc_errors["credit_topup"] = "boom"
        body, headers = signed({"id": "evt_3", "type": "checkout.session.completed", "data": {"object": self.session()}})
        self.assertEqual(self.client.post("/api/stripe/webhook", content=body, headers=headers).status_code, 400)
        self.assertEqual(self.rpcs("record_stripe_event"), [])

    def test_webhook_duplicates_and_account_updates(self):
        self.rpc_results["record_stripe_event"] = False
        account = {"id": "acct_host", "details_submitted": True, "payouts_enabled": True, "capabilities": {"transfers": "active"}}
        body, headers = signed({"id": "evt_4", "type": "account.updated", "data": {"object": account}})
        self.assertEqual(self.client.post("/api/stripe/webhook", content=body, headers=headers).json()["duplicate"], True)
        self.assertEqual(self.rpcs("sync_host_account")[-1][3], {"p_account": "acct_host", "p_details": True, "p_payouts": True})
        account["capabilities"] = {"transfers": "pending"}
        body, headers = signed({"id": "evt_5", "type": "account.updated", "data": {"object": account}})
        self.client.post("/api/stripe/webhook", content=body, headers=headers)
        self.assertFalse(self.rpcs("sync_host_account")[-1][3]["p_payouts"], "payouts need an active transfers capability")

    # Payouts -------------------------------------------------------------------------------------------
    def test_onboarding_creates_one_v2_recipient_account(self):
        accounts, links = self.stripe.v2.core.accounts, self.stripe.v2.core.account_links
        accounts.create.return_value = {"id": "acct_new"}
        links.create.return_value = {"url": "https://connect.stripe.com/setup/e/acct_new"}
        self.assertEqual(self.client.post("/api/payouts/onboard").json(), {"url": "https://connect.stripe.com/setup/e/acct_new"})
        create = accounts.create.call_args.kwargs
        self.assertEqual(create["params"]["contact_email"], "rae@example.com")
        self.assertEqual(create["params"]["dashboard"], "express")
        self.assertEqual(create["params"]["configuration"],
                         {"recipient": {"capabilities": {"stripe_balance": {"stripe_transfers": {"requested": True}}}}})
        self.assertEqual(create["options"], {"idempotency_key": f"grove-host-account-v2-{self.user_id}"})
        self.stripe.v1.accounts.create.assert_not_called()  # Stripe refuses Accounts v1 for new platforms
        self.assertEqual(self.rpcs("save_host_account")[-1][3], {"p_actor": self.user_id, "p_account": "acct_new"})
        link = links.create.call_args.kwargs["params"]
        self.assertEqual(link["account"], "acct_new")
        self.assertEqual(link["use_case"]["type"], "account_onboarding")
        self.assertEqual(link["use_case"]["account_onboarding"]["configurations"], ["recipient"])
        self.assertEqual(link["use_case"]["account_onboarding"]["return_url"], "https://grove.test/?payouts=return#wallet")
        self.account_rows = [{"stripe_account_id": "acct_new"}]
        accounts.create.reset_mock()
        self.client.post("/api/payouts/onboard")
        accounts.create.assert_not_called()

    def test_onboarding_without_connect_explains(self):
        self.stripe.v2.core.accounts.create.side_effect = stripe.InvalidRequestError(
            "You can only create new accounts if you've signed up for Connect", param=None)
        result = self.client.post("/api/payouts/onboard")
        self.assertEqual(result.status_code, 503)
        self.assertIn("Connect", result.json()["detail"])

    def test_refresh_reads_v2_transfer_capability(self):
        self.account_rows = [{"stripe_account_id": "acct_host"}]
        retrieve = self.stripe.v2.core.accounts.retrieve
        transfers = {"status": "restricted", "status_details": [{"code": "requirements_past_due"}]}
        retrieve.return_value = {"configuration": {"recipient": {"capabilities": {"stripe_balance": {"stripe_transfers": transfers}}}},
                                 "requirements": {"entries": [{"awaiting_action_from": "user", "description": "individual.dob"}]}}
        self.assertEqual(self.client.post("/api/payouts/refresh").json(), {"details_submitted": False, "payouts_enabled": False})
        self.assertEqual(retrieve.call_args.kwargs["params"], {"include": ["configuration.recipient", "requirements"]})
        transfers["status"] = "active"
        retrieve.return_value["requirements"]["entries"] = [{"awaiting_action_from": "stripe", "description": "review"}]
        self.assertEqual(self.client.post("/api/payouts/refresh").json(), {"details_submitted": True, "payouts_enabled": True})
        self.assertEqual(self.rpcs("sync_host_account")[-1][3], {"p_account": "acct_host", "p_details": True, "p_payouts": True})

    def test_withdraw_sends_one_transfer(self):
        self.stripe.v1.transfers.create.return_value = {"id": "tr_1"}
        result = self.client.post("/api/payouts/withdraw", json={"amount_usd": "12.34"})
        self.assertEqual(result.json(), {"id": "w-1", "status": "paid", "amount_usd": "12.34"})
        self.assertEqual(self.rpcs("request_withdrawal")[-1][3], {"p_actor": self.user_id, "p_amount_micros": 12340000})
        transfer = self.stripe.v1.transfers.create.call_args.kwargs
        self.assertEqual((transfer["params"]["amount"], transfer["params"]["destination"]), (1234, "acct_host"))
        self.assertEqual(transfer["options"], {"idempotency_key": "grove-withdrawal-w-1"})
        self.assertEqual(self.rpcs("complete_withdrawal")[-1][3], {"p_id": "w-1", "p_transfer": "tr_1"})

    def test_failed_transfer_returns_earnings(self):
        self.stripe.v1.transfers.create.side_effect = stripe.InvalidRequestError(
            "Insufficient funds", param=None, code="balance_insufficient")
        result = self.client.post("/api/payouts/withdraw", json={"amount_usd": "10"})
        self.assertEqual(result.status_code, 502)
        self.assertIn("returned", result.json()["detail"])
        self.assertEqual(self.rpcs("fail_withdrawal")[-1][3], {"p_id": "w-1", "p_reason": "balance_insufficient"})
        self.assertEqual(self.rpcs("complete_withdrawal"), [])

    def test_withdraw_validation_and_database_rules(self):
        for amount in ("0", "1.005", "-5"):
            self.assertEqual(self.client.post("/api/payouts/withdraw", json={"amount_usd": amount}).status_code, 422)
        for message, status in (("PAYOUTS_NOT_READY", 409), ("BELOW_MINIMUM", 422), ("INSUFFICIENT_EARNINGS", 409)):
            self.rpc_errors["request_withdrawal"] = message
            self.assertEqual(self.client.post("/api/payouts/withdraw", json={"amount_usd": "10"}).status_code, status)
        self.stripe.v1.transfers.create.assert_not_called()

    def test_payments_need_login_and_csrf(self):
        self.assertEqual(self.client.post("/api/wallet/checkout", json={"amount_usd": 25},
                                          headers={"X-Grove-Request": ""}).status_code, 403)
        self.client.cookies.clear()
        for path in ("/api/wallet/checkout", "/api/payouts/onboard", "/api/payouts/withdraw", "/api/wallet/checkout/confirm"):
            self.assertIn(self.client.post(path, json={}).status_code, (401, 422), path)
        self.assertEqual(self.client.get("/api/wallet").status_code, 401)


class InsufficientCreditsMappingTest(unittest.IsolatedAsyncioTestCase):
    async def test_booking_without_credits_is_402(self):
        transport = httpx.MockTransport(lambda r: httpx.Response(400, json={"code": "P0001", "message": "INSUFFICIENT_CREDITS"}))
        async with httpx.AsyncClient(base_url="https://test.invalid", transport=transport) as client:
            with self.assertRaises(Exception) as caught:
                await rpc(client, "create_job", {})
        self.assertEqual(caught.exception.status_code, 402)
        self.assertIn("Top up", caught.exception.detail)
