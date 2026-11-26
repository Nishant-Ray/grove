import json
import unittest
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from app.accounts import ACCESS, upstream
from app.main import app

INPUTS = {
    "gpu_model": "rtx-4090", "gpu_label": "NVIDIA RTX 4090", "vram_gb": 24, "base_rate_usd_hr": 0.273,
    "power_kw": 0.55, "usd_per_kwh": 0.165, "kwh_source": "state", "green_energy": True,
    "priority_multiplier": 1.3, "host_share": 0.8, "floor_margin": 1.5, "reserve_multiplier": 1.25,
}


class QuoteTest(unittest.TestCase):
    def setUp(self):
        self.rows = [dict(INPUTS)]
        self.requests = []

        def handle(request):
            self.requests.append(request)
            return httpx.Response(200, json=self.rows)

        async def fake():
            async with httpx.AsyncClient(base_url="https://test.invalid",
                                         transport=httpx.MockTransport(handle)) as client:
                yield client

        app.dependency_overrides[upstream] = fake
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.device = str(uuid4())
        self.params = {"host_device_id": self.device, "priority": "standard", "hours": "2"}

    def get(self, **overrides):
        return self.client.get("/api/quote", params={**self.params, **overrides})

    def test_requires_login(self):
        self.assertEqual(self.get().status_code, 401)
        self.assertEqual(self.requests, [])

    def test_quote_matches_the_formula(self):
        self.client.cookies.set(ACCESS, "renter-token")
        result = self.get(gpu="rtx-4090")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json(), {
            "host_device_id": self.device, "gpu": "rtx-4090", "gpu_label": "NVIDIA RTX 4090",
            "priority": "standard", "hours": "2", "reliability": "1.0",
            "rate_per_hr": "0.3549", "host_payout_per_hr": "0.2839", "grove_fee_per_hr": "0.0710",
            "power_floor_per_hr": "0.1362", "clears_floor": True, "kwh_source": "state",
            "green_energy": True, "estimate": "0.71", "reserve": "0.89", "host_payout_estimate": "0.57",
        })
        request = self.requests[-1]
        self.assertEqual(request.url.path, "/rest/v1/rpc/quote_inputs")
        self.assertEqual(request.headers["authorization"], "Bearer renter-token")
        self.assertEqual(json.loads(request.content), {"p_device_id": self.device, "p_priority": "standard"})

    def test_expensive_power_fails_the_floor(self):
        self.client.cookies.set(ACCESS, "renter-token")
        self.rows = [{**INPUTS, "usd_per_kwh": 0.41, "priority_multiplier": 1.0}]
        body = self.get(priority="batch").json()
        self.assertEqual(body["host_payout_per_hr"], "0.2184")
        self.assertFalse(body["clears_floor"])

    def test_invalid_requests(self):
        self.client.cookies.set(ACCESS, "renter-token")
        self.assertEqual(self.get(gpu="rtx-3060").status_code, 422)
        self.assertEqual(self.get(hours="0").status_code, 422)
        self.assertEqual(self.get(hours="169").status_code, 422)
        self.assertEqual(self.get(hours="0.001").status_code, 422)
        self.assertEqual(self.get(hours="NaN").status_code, 422)
        self.assertEqual(self.get(priority="Bad Level").status_code, 422)
        self.rows = [{**INPUTS, "priority_multiplier": None}]
        self.assertEqual(self.get(priority="turbo").status_code, 422)
        self.rows = [{**INPUTS, "gpu_model": None}]
        self.assertEqual(self.get().status_code, 409)
        self.rows = [{**INPUTS, "usd_per_kwh": None}]
        self.assertEqual(self.get().status_code, 503)
        self.rows = [{**INPUTS, "host_share": None}]
        self.assertEqual(self.get().status_code, 503)
        self.rows = []
        self.assertEqual(self.get().status_code, 404)

    def test_rate_tables_are_public(self):
        self.rows = [{"gpu_model": "rtx-4090"}]
        self.assertEqual(self.client.get("/api/gpu-rates").json(), self.rows)
        self.assertNotIn("authorization", self.requests[-1].headers)
        self.assertEqual(self.requests[-1].url.params["active"], "eq.true")
        self.assertEqual(self.client.get("/api/priority-levels").status_code, 200)
