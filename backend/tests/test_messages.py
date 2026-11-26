import json
import unittest
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from app.accounts import ACCESS, upstream
from app.main import app


class MessagesTest(unittest.TestCase):
    def setUp(self):
        self.me, self.other = str(uuid4()), str(uuid4())
        self.job_id = str(uuid4())
        self.requests = []
        self.job = {"id": self.job_id, "name": "Train", "status": "scheduled", "accepted_at": "2026-11-26T10:00:00Z",
                    "finished_at": None}
        self.people = [{"role": "renter", "renter_name": "Rae", "host_name": "Hana", "device_name": "Lab 4090"}]
        self.thread_open = True
        self.insert_status = 201
        self.messages = [
            {"id": str(uuid4()), "sender_id": self.me, "body": "Hi", "created_at": "2026-11-26T10:01:00Z"},
            {"id": str(uuid4()), "sender_id": self.other, "body": "Hello", "created_at": "2026-11-26T10:02:00Z"},
        ]

        def handle(request):
            self.requests.append(request)
            path = request.url.path
            if path == "/auth/v1/user":
                return httpx.Response(200, json={"id": self.me})
            if path == "/rest/v1/compute_jobs":
                return httpx.Response(200, json=[self.job] if self.job else [])
            if path == "/rest/v1/rpc/job_participants":
                return httpx.Response(200, json=self.people)
            if path == "/rest/v1/rpc/job_thread_open":
                return httpx.Response(200, json=self.thread_open)
            if path == "/rest/v1/messages" and request.method == "POST":
                if self.insert_status != 201:
                    return httpx.Response(self.insert_status, json={"code": "42501", "message": "row-level security"})
                body = json.loads(request.content)
                return httpx.Response(201, json=[{"id": str(uuid4()), "body": body["body"], "created_at": "now"}])
            if path == "/rest/v1/messages":
                return httpx.Response(200, json=self.messages)
            if path == "/rest/v1/reviews":
                return httpx.Response(200, json=[])
            if path == "/rest/v1/message_reads":
                return httpx.Response(self.insert_status if self.insert_status != 201 else 201)
            return httpx.Response(204)

        async def fake():
            async with httpx.AsyncClient(base_url="https://test.invalid",
                                         transport=httpx.MockTransport(handle)) as client:
                yield client

        app.dependency_overrides[upstream] = fake
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app, headers={"X-Grove-Request": "1"})
        self.addCleanup(self.client.close)
        self.client.cookies.set(ACCESS, "user-token")

    def paths(self):
        return [(r.method, r.url.path) for r in self.requests]

    def test_job_detail(self):
        body = self.client.get(f"/api/jobs/{self.job_id}").json()
        self.assertEqual(body["role"], "renter")
        self.assertEqual(body["host_name"], "Hana")
        self.assertEqual(body["messaging"], {"visible": True, "can_send": True})
        self.assertTrue(all(r.headers.get("authorization") == "Bearer user-token"
                            for r in self.requests if r.url.path.startswith("/rest/")))

    def test_job_detail_before_acceptance_and_for_outsiders(self):
        self.job = {**self.job, "status": "requested", "accepted_at": None}
        body = self.client.get(f"/api/jobs/{self.job_id}").json()
        self.assertEqual(body["messaging"], {"visible": False, "can_send": False})
        self.assertNotIn(("POST", "/rest/v1/rpc/job_thread_open"), self.paths())
        self.people = []
        self.assertEqual(self.client.get(f"/api/jobs/{self.job_id}").status_code, 404)
        self.job = None
        self.assertEqual(self.client.get(f"/api/jobs/{self.job_id}").status_code, 404)

    def test_list_marks_my_messages(self):
        body = self.client.get(f"/api/jobs/{self.job_id}/messages").json()
        self.assertEqual([(m["body"], m["mine"]) for m in body["messages"]], [("Hi", True), ("Hello", False)])
        self.assertNotIn("sender_id", body["messages"][0])
        listing = [r for r in self.requests if r.url.path == "/rest/v1/messages"][-1]
        self.assertEqual(listing.url.params["order"], "created_at,id")
        self.client.get(f"/api/jobs/{self.job_id}/messages", params={"after": "2026-11-26T10:01:00Z"})
        listing = [r for r in self.requests if r.url.path == "/rest/v1/messages"][-1]
        self.assertEqual(listing.url.params["created_at"], "gte.2026-11-26T10:01:00+00:00")

    def test_send(self):
        result = self.client.post(f"/api/jobs/{self.job_id}/messages", json={"body": "  Data is ready  "})
        self.assertEqual(result.status_code, 201, result.text)
        self.assertTrue(result.json()["mine"])
        insert = [r for r in self.requests if r.method == "POST" and r.url.path == "/rest/v1/messages"][-1]
        self.assertEqual(json.loads(insert.content), {"job_id": self.job_id, "body": "Data is ready"})
        self.assertEqual(insert.headers["authorization"], "Bearer user-token")

    def test_send_routes_past_job_actions(self):
        # Regression: POST /api/jobs/{id}/messages must not be treated as a job action.
        self.assertEqual(self.client.post(f"/api/jobs/{self.job_id}/messages", json={"body": "x"}).status_code, 201)

    def test_send_rejections(self):
        for body in ("", "   ", "x" * 2001):
            self.assertEqual(self.client.post(f"/api/jobs/{self.job_id}/messages", json={"body": body}).status_code, 422)
        self.insert_status = 403
        result = self.client.post(f"/api/jobs/{self.job_id}/messages", json={"body": "Hi"})
        self.assertEqual(result.status_code, 403)
        self.assertIn("opens once the host accepts", result.json()["detail"])
        self.client.headers.pop("X-Grove-Request")
        self.assertEqual(self.client.post(f"/api/jobs/{self.job_id}/messages", json={"body": "Hi"}).status_code, 403)

    def test_mark_read_updates_marker_and_notification(self):
        self.assertEqual(self.client.post(f"/api/jobs/{self.job_id}/messages/read").status_code, 200)
        upsert = [r for r in self.requests if r.url.path == "/rest/v1/message_reads"][-1]
        self.assertEqual(upsert.url.params["on_conflict"], "job_id,user_id")
        self.assertIn("merge-duplicates", upsert.headers["prefer"])
        patch = [r for r in self.requests if r.url.path == "/rest/v1/notifications"][-1]
        self.assertEqual((patch.method, patch.url.params["kind"], patch.url.params["job_id"]),
                         ("PATCH", "eq.new_message", "eq." + self.job_id))
        self.insert_status = 403
        self.assertEqual(self.client.post(f"/api/jobs/{self.job_id}/messages/read").status_code, 404)

    def test_requires_login(self):
        self.client.cookies.clear()
        self.assertEqual(self.client.get(f"/api/jobs/{self.job_id}/messages").status_code, 401)
        self.assertEqual(self.client.post(f"/api/jobs/{self.job_id}/messages", json={"body": "x"}).status_code, 401)
