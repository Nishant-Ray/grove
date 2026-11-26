"""Recommendations, booking and lifecycle endpoints, with Supabase mocked at the HTTP layer."""
import json
import unittest
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from app.accounts import ACCESS, admin, upstream
from app.main import app
from tests.test_quotes import INPUTS


def candidate(name, base, *, green=False, distance=None, power=0.55, kwh=0.165, vram=24, rating=None, reviews=0):
    return {"device_id": str(uuid4()), "device_name": name, "host_id": str(uuid4()), "host_name": "Host " + name,
            "host_rating": rating, "host_reviews": reviews, "jobs_completed": reviews, "completion_rate": None,
            "gpu_model": "rtx-4090", "gpu_label": "NVIDIA RTX 4090", "vram_gb": vram,
            "base_rate_usd_hr": base, "power_kw": power, "usd_per_kwh": kwh, "green_energy": green,
            "state": "NY", "distance_miles": distance, "priority_multiplier": 1.3, "host_share": 0.8,
            "floor_margin": 1.5, "reserve_multiplier": 1.25}


class MarketplaceTest(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid4())
        self.calls = []  # (client, path, json body)
        self.candidates = []
        self.inputs = [dict(INPUTS)]
        self.rpc_reply = {"id": str(uuid4()), "status": "scheduled"}
        self.rpc_status = 200

        def handler(kind):
            def handle(request):
                body = json.loads(request.content) if request.content else None
                self.calls.append((kind, request.url.path, body, request))
                path = request.url.path
                if path == "/auth/v1/user":
                    return httpx.Response(200, json={"id": self.user_id})
                if path == "/rest/v1/rpc/quote_inputs":
                    return httpx.Response(200, json=self.inputs)
                if path == "/rest/v1/rpc/recommend_hosts" and self.candidates is not None:
                    return httpx.Response(200, json=self.candidates)
                if path == "/rest/v1/rpc/device_heartbeat":
                    return httpx.Response(200, json=2)
                return httpx.Response(self.rpc_status, json=self.rpc_reply)
            return handle

        def fake(kind):
            async def dependency():
                async with httpx.AsyncClient(base_url="https://test.invalid",
                                             transport=httpx.MockTransport(handler(kind))) as client:
                    yield client
            return dependency

        app.dependency_overrides[upstream] = fake("user")
        app.dependency_overrides[admin] = fake("admin")
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app, headers={"X-Grove-Request": "1"})
        self.addCleanup(self.client.close)
        self.client.cookies.set(ACCESS, "renter-token")

    def rpc_calls(self, name):
        return [c for c in self.calls if c[1] == f"/rest/v1/rpc/{name}"]

    # Recommendations ----------------------------------------------------------------
    def test_recommendations_filter_by_floor_and_sort_by_price(self):
        cheap, pricey = candidate("cheap", 0.20), candidate("pricey", 0.30)
        hot_power = candidate("hawaii", 0.10, kwh=0.41)  # payout 0.104 < floor 0.3383
        self.candidates = [pricey, hot_power, cheap]
        body = self.client.get("/api/hosts/recommendations", params={"hours": "2", "min_vram": 16}).json()
        self.assertEqual([h["device_name"] for h in body["hosts"]], ["cheap", "pricey"])
        self.assertEqual(body["hosts"][0]["rate_per_hr"], "0.2600")
        self.assertEqual(body["hosts"][0]["estimate"], "0.52")
        self.assertNotIn("_rate", body["hosts"][0])
        kind, _, args, _ = self.rpc_calls("recommend_hosts")[-1]
        self.assertEqual(kind, "admin")
        self.assertEqual(args, {"p_actor": self.user_id, "p_priority": "standard", "p_min_vram": 16,
                                "p_gpu_model": None, "p_renter_zip": None})

    def test_green_sort_and_filters(self):
        self.candidates = [candidate("grey", 0.20, distance=10), candidate("green", 0.30, green=True, distance=400.4),
                           candidate("nowhere", 0.25, distance=None)]
        get = lambda **p: [h["device_name"] for h in self.client.get("/api/hosts/recommendations", params=p).json()["hosts"]]
        self.assertEqual(get(sort="green"), ["green", "grey", "nowhere"])
        self.assertEqual(get(green_only="true"), ["green"])
        self.assertEqual(get(zip="14850", max_miles=100), ["grey"])
        self.assertEqual(get(zip="14850", max_miles=500), ["grey", "green"])
        self.assertEqual(get(sort="rating"), ["grey", "nowhere", "green"])  # no ratings yet: price order
        hosts = self.client.get("/api/hosts/recommendations", params={"zip": "14850"}).json()["hosts"]
        self.assertEqual({h["device_name"]: h["distance_miles"] for h in hosts},
                         {"grey": 10, "green": 400, "nowhere": None})

    def test_recommendation_validation(self):
        self.assertEqual(self.client.get("/api/hosts/recommendations", params={"max_miles": 50}).status_code, 422)
        self.assertEqual(self.client.get("/api/hosts/recommendations", params={"zip": "1485"}).status_code, 422)
        self.assertEqual(self.client.get("/api/hosts/recommendations", params={"sort": "distance"}).status_code, 422)
        self.rpc_status, self.rpc_reply = 400, {"code": "P0001", "message": "UNKNOWN_PRIORITY"}
        self.candidates = None  # recommend_hosts now answers with rpc_reply
        self.assertEqual(self.client.get("/api/hosts/recommendations", params={"priority": "turbo"}).status_code, 422)
        self.client.cookies.clear()
        self.assertEqual(self.client.get("/api/hosts/recommendations").status_code, 401)

    # Booking ------------------------------------------------------------------------
    def test_booking_requotes_on_the_server(self):
        device = str(uuid4())
        result = self.client.post("/api/jobs", json={
            "name": "Train model", "host_device_id": device, "priority": "standard", "hours": "2",
            "min_vram_gb": 16, "code_link": "https://github.com/me/repo",
            "rate_per_hr": "0.0001", "p_rate": "0.0001",  # tampering attempts are ignored
        })
        self.assertEqual(result.status_code, 201, result.text)
        quote_kind, _, _, quote_req = self.rpc_calls("quote_inputs")[-1]
        self.assertEqual((quote_kind, quote_req.headers["authorization"]), ("user", "Bearer renter-token"))
        kind, _, args, _ = self.rpc_calls("create_job")[-1]
        self.assertEqual(kind, "admin")
        self.assertEqual(args, {"p_actor": self.user_id, "p_device_id": device, "p_name": "Train model",
                                "p_priority": "standard", "p_hours": "2", "p_min_vram": 16,
                                "p_code_link": "https://github.com/me/repo", "p_rate": "0.3549",
                                "p_payout": "0.2839", "p_reserve_micros": 887250})

    def test_booking_rejects_hosts_below_the_floor_and_bad_input(self):
        job = {"name": "x", "host_device_id": str(uuid4()), "priority": "batch", "hours": "1"}
        self.inputs = [{**INPUTS, "usd_per_kwh": 0.41, "priority_multiplier": 1.0}]
        self.assertEqual(self.client.post("/api/jobs", json=job).status_code, 409)
        self.assertEqual(self.rpc_calls("create_job"), [])
        self.inputs = [dict(INPUTS)]
        for bad in ({"code_link": "javascript:alert(1)"}, {"hours": "0"}, {"name": ""}, {"min_vram_gb": -1}):
            self.assertEqual(self.client.post("/api/jobs", json={**job, **bad}).status_code, 422, bad)

    def test_database_errors_map_to_clear_responses(self):
        job = {"name": "x", "host_device_id": str(uuid4()), "priority": "standard", "hours": "1"}
        for message, status in (("DEVICE_BUSY", 409), ("OWN_DEVICE", 409), ("DEVICE_UNAVAILABLE", 409),
                                ("NOT_ENOUGH_VRAM", 409), ("DEVICE_NOT_FOUND", 404)):
            self.rpc_status, self.rpc_reply = 400, {"code": "P0001", "message": message}
            self.assertEqual(self.client.post("/api/jobs", json=job).status_code, status, message)
        self.rpc_status, self.rpc_reply = 400, {"code": "23514", "message": "violates check constraint"}
        response = self.client.post("/api/jobs", json=job)
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("constraint", response.text)
        self.rpc_status, self.rpc_reply = 500, {"message": "boom"}
        self.assertEqual(self.client.post("/api/jobs", json=job).status_code, 503)

    # Lifecycle ------------------------------------------------------------------------
    def test_actions_pass_the_verified_actor(self):
        job = str(uuid4())
        self.assertEqual(self.client.post(f"/api/jobs/{job}/complete", json={"summary": "done"}).status_code, 200)
        kind, _, args, _ = self.rpc_calls("job_action")[-1]
        self.assertEqual(kind, "admin")
        self.assertEqual(args, {"p_actor": self.user_id, "p_job_id": job, "p_action": "complete", "p_summary": "done"})
        self.assertEqual(self.client.post(f"/api/jobs/{job}/start").status_code, 200)
        self.assertIsNone(self.rpc_calls("job_action")[-1][2]["p_summary"])
        self.assertEqual(self.client.post(f"/api/jobs/{job}/explode").status_code, 422)
        for message, status in (("NOT_ALLOWED", 403), ("JOB_NOT_FOUND", 404), ("INVALID_TRANSITION", 409)):
            self.rpc_status, self.rpc_reply = 400, {"code": "P0001", "message": message}
            self.assertEqual(self.client.post(f"/api/jobs/{job}/start").status_code, status)

    def test_actions_require_login_and_csrf_header(self):
        job = str(uuid4())
        self.assertEqual(self.client.post(f"/api/jobs/{job}/start", headers={"X-Grove-Request": ""}).status_code, 403)
        self.client.cookies.clear()
        self.assertEqual(self.client.post(f"/api/jobs/{job}/start").status_code, 401)
        self.assertEqual(self.rpc_calls("job_action"), [])

    def test_heartbeat(self):
        self.assertEqual(self.client.post("/api/devices/heartbeat").json(), {"devices": 2})
        self.assertEqual(self.rpc_calls("device_heartbeat")[-1][2], {"p_actor": self.user_id})
