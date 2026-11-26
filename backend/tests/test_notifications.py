import json
import unittest
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from app.accounts import ACCESS, upstream
from app.main import app


class NotificationsTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.rows = [{"id": str(uuid4()), "kind": "job_started", "title": "Job started"}]
        self.unread = 3

        def handle(request):
            self.requests.append(request)
            if request.method == "PATCH":
                return httpx.Response(204)
            if request.url.params.get("select") == "id":
                return httpx.Response(200, json=[{"id": str(uuid4())} for _ in range(self.unread)])
            return httpx.Response(200, json=self.rows)

        async def fake():
            async with httpx.AsyncClient(base_url="https://test.invalid",
                                         transport=httpx.MockTransport(handle)) as client:
                yield client

        app.dependency_overrides[upstream] = fake
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app, headers={"X-Grove-Request": "1"})
        self.addCleanup(self.client.close)
        self.client.cookies.set(ACCESS, "user-token")

    def test_list_with_unread_count(self):
        body = self.client.get("/api/notifications").json()
        self.assertEqual(body, {"notifications": self.rows, "unread": 3, "unread_more": False})
        listing = self.requests[0]
        self.assertEqual(listing.headers["authorization"], "Bearer user-token")
        self.assertEqual(listing.url.params["order"], "created_at.desc,id.desc")
        self.assertNotIn("read_at", listing.url.params)
        self.client.get("/api/notifications", params={"unread_only": "true", "limit": 5})
        self.assertEqual(self.requests[-2].url.params["read_at"], "is.null")
        self.assertEqual(self.requests[-2].url.params["limit"], "5")

    def test_unread_count_is_capped(self):
        self.unread = 100
        self.assertEqual(self.client.get("/api/notifications").json()["unread"], 99)
        self.assertTrue(self.client.get("/api/notifications").json()["unread_more"])

    def test_mark_read(self):
        ids = [str(uuid4()), str(uuid4())]
        self.assertEqual(self.client.post("/api/notifications/read", json={"ids": ids}).status_code, 200)
        patch = self.requests[-1]
        self.assertEqual(patch.method, "PATCH")
        self.assertEqual(patch.url.params["id"], f"in.({ids[0]},{ids[1]})")
        self.assertEqual(patch.url.params["read_at"], "is.null")
        self.assertEqual(list(json.loads(patch.content)), ["read_at"])  # only read_at is ever written
        self.client.post("/api/notifications/read", json={})
        self.assertNotIn("id", self.requests[-1].url.params)
        count = len(self.requests)
        self.client.post("/api/notifications/read", json={"ids": []})
        self.assertEqual(len(self.requests), count)

    def test_validation_and_auth(self):
        self.assertEqual(self.client.post("/api/notifications/read", json={"ids": ["not-a-uuid"]}).status_code, 422)
        self.assertEqual(self.client.post("/api/notifications/read", json={"ids": [str(uuid4())] * 101}).status_code, 422)
        self.assertEqual(self.client.get("/api/notifications", params={"limit": 0}).status_code, 422)
        self.client.cookies.clear()
        self.assertEqual(self.client.get("/api/notifications").status_code, 401)
