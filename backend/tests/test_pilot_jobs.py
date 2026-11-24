import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from app.accounts import ACCESS, upstream
from app.main import app


class PilotJobTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.owner = str(uuid4())

        def handle(req):
            self.calls.append(req)
            path = req.url.path
            if path == "/auth/v1/user":
                return httpx.Response(200, json={"id": self.owner})
            if path.endswith("/stage_job"):
                return httpx.Response(200, json=True)
            if path.endswith("/device_job"):
                return httpx.Response(200, content=b"null")
            if path.startswith("/storage/v1/object/upload/sign/"):
                return httpx.Response(200, json={"url": path.removeprefix("/storage/v1") + "?token=upload"})
            raise AssertionError(path)

        async def fake():
            async with httpx.AsyncClient(base_url="https://test.invalid", headers={"apikey": "public"},
                                         transport=httpx.MockTransport(handle)) as client:
                yield client

        app.dependency_overrides[upstream] = fake
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app, headers={"X-Grove-Request": "1"})
        self.addCleanup(self.client.close)
        self.env = patch.dict("os.environ", {"SUPABASE_SECRET_KEY": "sb_secret_server"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.job = {"id": str(uuid4()), "device_id": str(uuid4()), "name": "Count", "cpus": 1,
                    "memory_mib": 256, "seconds": 20, "files": [{"name": "main.py", "size": 80}]}

    def test_signed_inputs_follow_authenticated_staging(self):
        self.assertEqual(self.client.post("/api/jobs/stage", json=self.job).status_code, 401)
        self.client.cookies.set(ACCESS, "renter")
        res = self.client.post("/api/jobs/stage", json=self.job)
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("sb_secret", res.text)
        self.assertEqual(self.calls[0].headers["authorization"], "Bearer renter")
        self.assertEqual(self.calls[1].headers["apikey"], "sb_secret_server")
        self.assertIn(self.owner.encode(), self.calls[1].content)
        self.assertIn(self.job["id"] + "/main.py", res.json()["uploads"][0])

    def test_invalid_manifest_cannot_mint_links(self):
        self.client.cookies.set(ACCESS, "renter")
        for name in ("../data", "NUL.txt", "MAIN.PY", "data."):
            self.job["files"] = [{"name": "main.py", "size": 1}, {"name": name, "size": 1}]
            self.assertEqual(self.client.post("/api/jobs/stage", json=self.job).status_code, 422)
        self.assertFalse(self.calls)

    def test_device_scope_before_result_upload(self):
        data = {"action": "upload", "job": self.job["id"], "attempt": str(uuid4())}
        self.client.cookies.set(ACCESS, "renter")
        self.assertEqual(self.client.post("/api/hosts/work", json=data).status_code, 401)
        response = self.client.post("/api/hosts/work", json=data,
                                    headers={"Authorization": "Bearer 1800000000." + "a" * 64})
        self.assertEqual(response.status_code, 409)
        self.assertEqual([r.url.path for r in self.calls], ["/rest/v1/rpc/device_job"])
