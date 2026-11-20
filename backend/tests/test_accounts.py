"""Account API contract tests using an in-memory Supabase HTTP transport."""
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from app.accounts import upstream
from app.main import app


class AccountsTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.user = {"email": "host@example.org", "user_metadata": {"display_name": "Host"}}
        self.reply = {}
        self.status = 200

        def handle(request):
            self.calls.append(request)
            return httpx.Response(self.status, json=self.reply)

        async def fake():
            async with httpx.AsyncClient(base_url="https://test.invalid",
                                         transport=httpx.MockTransport(handle)) as client:
                yield client

        app.dependency_overrides[upstream] = fake
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app, base_url="https://grove.test", headers={"X-Grove-Request": "1"})
        self.addCleanup(self.client.close)
        self.session = {"user": self.user, "access_token": "access", "refresh_token": "refresh",
                        "expires_in": 3600}
        self.credentials = {"email": self.user["email"], "password": "test-password"}

    def test_confirmed_registration_and_session(self):
        self.reply = {"id": str(uuid4())}
        with patch.dict("os.environ", {"GROVE_WEB_URL": "https://grove.test"}):
            result = self.client.post("/api/auth/register", json={**self.credentials, "display_name": "Host"})
        self.assertEqual(result.json(), {"user": None})
        self.assertEqual(self.calls[-1].url.params["redirect_to"], "https://grove.test/api/auth/confirm")
        self.reply = self.session
        result = self.client.get("/api/auth/confirm?code=one-time", follow_redirects=False)
        self.assertEqual(result.headers["location"], "/#account")
        self.assertEqual(self.calls[-1].url.params["grant_type"], "pkce")
        self.assertIn("HttpOnly", result.headers["set-cookie"])
        self.reply = self.user
        self.assertEqual(self.client.get("/api/profile").json()["email"], self.user["email"])
        self.assertEqual(self.calls[-1].headers["authorization"], "Bearer access")

    def test_login_refresh_and_logout(self):
        self.reply = self.session
        self.assertEqual(self.client.post("/api/auth/login", json=self.credentials).status_code, 200)
        self.assertEqual(self.client.post("/api/auth/refresh").status_code, 200)
        self.assertEqual(self.calls[-1].url.params["grant_type"], "refresh_token")
        self.assertEqual(self.client.post("/api/auth/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/profile").status_code, 401)
        self.assertEqual(self.client.post("/api/auth/refresh").status_code, 401)

    def test_device_ownership_is_delegated_to_user_scoped_database_policies(self):
        self.reply = self.session
        self.client.post("/api/auth/login", json=self.credentials)
        device = {"name": "Lab", "hardware": "GPU", "availability": "paused"}
        self.reply = [{"id": str(uuid4()), **device}]
        result = self.client.post("/api/devices", json={**device, "owner_id": "somebody-else"})
        self.assertEqual(result.status_code, 201)
        self.assertEqual(self.calls[-1].headers["authorization"], "Bearer access")
        self.assertNotIn(b"owner_id", self.calls[-1].content)
        self.reply = []
        path = "/api/devices/" + result.json()["id"]
        self.assertEqual(self.client.put(path, json=device).status_code, 404)
        self.assertEqual(self.client.delete(path).status_code, 404)

    def test_invalid_requests_do_not_echo_passwords_or_reach_supabase(self):
        self.client.headers.pop("X-Grove-Request")
        self.assertEqual(self.client.post("/api/auth/login", json=self.credentials).status_code, 403)
        response = self.client.post("/api/auth/register", json={**self.credentials, "password": "short"},
                                    headers={"X-Grove-Request": "1"})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("short", response.text)
        self.assertEqual(self.calls, [])
