"""Account API contract tests using an in-memory Supabase HTTP transport."""
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from app.accounts import DeviceSpecs, upstream
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

    def test_signup_starts_onboarding_and_existing_accounts_keep_dashboard(self):
        self.reply = {"id": str(uuid4())}
        self.client.post("/api/auth/register", json={**self.credentials, "display_name": "New"})
        self.assertEqual(json.loads(self.calls[-1].content)["data"]["workspace_mode"], "new")
        self.reply = self.session
        login = self.client.post("/api/auth/login", json=self.credentials)
        self.assertEqual(login.json()["user"]["workspace_mode"], "rent")
        self.reply = {**self.user, "user_metadata": {"workspace_mode": "host_setup"}}
        result = self.client.put("/api/profile/preference", json={"mode": "host_setup"})
        self.assertEqual(result.json()["workspace_mode"], "host_setup")
        self.assertEqual(json.loads(self.calls[-1].content), {"data": {"workspace_mode": "host_setup"}})
        self.assertEqual(self.client.put("/api/profile/preference", json={"mode": "invalid"}).status_code, 422)

    def test_device_specs_and_legacy_edits(self):
        self.reply = self.session
        self.client.post("/api/auth/login", json=self.credentials)
        device = {"name": "Workstation", "hardware": "Ryzen", "availability": "paused"}
        specs = {"cpu": "Ryzen", "ram_gb": 32, "os": "Linux", "acceptance": "manual"}
        self.reply = [{**device, "specs": specs}]
        path = "/api/devices/" + str(uuid4())
        self.assertEqual(self.client.put(path, json={**device, "specs": specs}).status_code, 200)
        self.assertEqual(json.loads(self.calls[-1].content)["specs"],
                         {**specs, "gpu": None, "vram_gb": None, "storage_gb": None, "hosting_hours": ""})
        partial = {"cpu": "Ryzen", "ram_gb": 32, "os": "Linux"}
        self.client.put(path, json={**device, "specs": partial})
        self.assertEqual(json.loads(self.calls[-1].content)["specs"]["acceptance"], "automatic")
        self.assertEqual(self.client.put(path, json={**device, "specs": {**specs, "ram_gb": -1}}).status_code, 422)
        self.client.put(path, json=device)
        self.assertNotIn("specs", json.loads(self.calls[-1].content))

    def test_invalid_requests_do_not_echo_passwords_or_reach_supabase(self):
        self.client.headers.pop("X-Grove-Request")
        self.assertEqual(self.client.post("/api/auth/login", json=self.credentials).status_code, 403)
        response = self.client.post("/api/auth/register", json={**self.credentials, "password": "short"},
                                    headers={"X-Grove-Request": "1"})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("short", response.text)
        self.assertEqual(self.calls, [])

    def test_device_pricing_fields(self):
        self.reply = self.session
        self.client.post("/api/auth/login", json=self.credentials)
        device = {"name": "Rig", "hardware": "Ryzen", "gpu_model": "rtx-4090", "zip": "14850",
                  "usd_per_kwh_override": 0.12, "green_energy": True}
        self.reply = [{"id": str(uuid4()), **device}]
        self.assertEqual(self.client.post("/api/devices", json=device).status_code, 201)
        sent = json.loads(self.calls[-1].content)
        self.assertEqual((sent["gpu_model"], sent["zip"], sent["green_energy"]), ("rtx-4090", "14850", True))
        self.assertIn("gpu_model", self.calls[-1].url.params["select"])
        for bad in ({"zip": "1485"}, {"zip": "١٢٣٤٥"}, {"gpu_model": "RTX 4090"}, {"usd_per_kwh_override": 5}):
            self.assertEqual(self.client.post("/api/devices", json={**device, **bad}).status_code, 422)
        self.assertEqual(DeviceSpecs(cpu="x", ram_gb=1, os="Linux").acceptance, "automatic")


class SettingsTest(unittest.TestCase):
    """Regression: a secret pasted into Vercel with a leading space or trailing newline made httpx
    refuse to send the header, so every service-role call answered 503 in production."""

    def test_keys_are_trimmed_before_use(self):
        import asyncio
        from app.accounts import admin, setting
        env = {"SUPABASE_URL": " https://example.supabase.co/\n", "SUPABASE_SECRET_KEY": " sb_secret_abc\n",
               "GROVE_COOKIE_SECURE": " false "}
        with patch.dict("os.environ", env):
            self.assertEqual(setting("SUPABASE_SECRET_KEY"), "sb_secret_abc")
            from app.accounts import secure_cookies
            self.assertFalse(secure_cookies())

            async def headers():
                generator = admin()
                client = await generator.__anext__()
                try:
                    return dict(client.headers), str(client.base_url)
                finally:
                    await generator.aclose()
            sent, base = asyncio.run(headers())
        self.assertEqual(sent["apikey"], "sb_secret_abc")
        self.assertNotIn("authorization", sent)  # new-style keys go in apikey only
        self.assertEqual(base, "https://example.supabase.co")
