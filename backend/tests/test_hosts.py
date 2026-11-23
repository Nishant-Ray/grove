import json
import unittest
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from app.accounts import ACCESS, upstream
from app.main import app


class HostPairingTest(unittest.TestCase):
    def setUp(self):
        self.reply = None
        self.requests = []

        def handle(request):
            self.requests.append(request)
            return httpx.Response(200, content=json.dumps(self.reply))

        async def fake():
            async with httpx.AsyncClient(base_url="https://test.invalid",
                                         transport=httpx.MockTransport(handle)) as client:
                yield client

        app.dependency_overrides[upstream] = fake
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app, headers={"X-Grove-Request": "1"})
        self.addCleanup(self.client.close)
        self.approval = {"device_id": str(uuid4()), "fingerprint": "a" * 64, "expires": 1800000000}
        self.pulse = {"online": True, "limits": {"cpus": 2, "memory_mib": 2048},
                      "capabilities": {"os": "Linux", "arch": "aarch64", "engine_arch": "arm64",
                                       "cpus": 4, "memory_mib": 4096, "disk_mib": 10000,
                                       "runtime": "ready", "checksum_verified": True, "agent_version": "0.1.0"}}

    def test_owner_actions(self):
        path = "/api/hosts"
        self.assertEqual(self.client.post(path + "/approve", json=self.approval).status_code, 401)
        self.client.cookies.set(ACCESS, "owner")
        self.reply = False
        self.assertEqual(self.client.post(path + "/approve", json=self.approval).status_code, 409)
        self.assertEqual(self.requests[-1].headers["authorization"], "Bearer owner")
        self.assertEqual(self.client.delete(path + "/" + str(uuid4())).status_code, 404)
        self.reply = True
        self.assertEqual(self.client.post(path + "/approve", json=self.approval).status_code, 200)
        self.reply = []
        self.assertEqual(self.client.get(path).json(), [])

    def test_heartbeat_authority_and_capacity(self):
        path = "/api/hosts/heartbeat"
        self.client.cookies.set(ACCESS, "owner")
        self.assertEqual(self.client.post(path, json=self.pulse).status_code, 401)
        headers = {"Authorization": "Bearer 1800000000." + "b" * 64}
        response = self.client.post(path, headers=headers, json=self.pulse)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers["X-Grove-Device"], "unlinked")
        self.assertNotIn("authorization", self.requests[-1].headers)
        self.reply = "Pilot workstation"
        self.assertEqual(self.client.post(path, headers=headers, json=self.pulse).json(), {"device": self.reply})
        self.pulse["limits"]["cpus"] = 6
        self.assertEqual(self.client.post(path, headers=headers, json=self.pulse).status_code, 422)
        self.pulse["limits"]["cpus"] = 2
        self.pulse["capabilities"]["checksum_verified"] = False
        self.assertEqual(self.client.post(path, headers=headers, json=self.pulse).status_code, 422)
        self.pulse["online"] = False
        self.assertEqual(self.client.post(path, headers=headers, json=self.pulse).status_code, 200)
