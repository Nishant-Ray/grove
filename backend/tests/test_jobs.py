import unittest
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from app.accounts import ACCESS, upstream
from app.main import app


class JobDashboardTest(unittest.TestCase):
    def setUp(self):
        self.rows = []
        self.requests = []

        def handle(request):
            self.requests.append(request)
            if request.url.path.startswith("/storage/"):
                return httpx.Response(200, content=b"job output")
            return httpx.Response(200, json=self.rows)

        async def fake():
            async with httpx.AsyncClient(base_url="https://test.invalid",
                                         transport=httpx.MockTransport(handle)) as client:
                yield client

        app.dependency_overrides[upstream] = fake
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_job_views_and_pagination(self):
        self.assertEqual(self.client.get("/api/jobs").status_code, 401)
        self.client.cookies.set(ACCESS, "owner-token")
        self.rows = [{"id": str(uuid4())} for _ in range(21)]
        for view, statuses in [("active", "in.(scheduled,running)"), ("requests", "eq.requested"),
                               ("history", "in.(completed,failed,cancelled)")]:
            response = self.client.get("/api/jobs", params={"group": view, "offset": 20})
            self.assertEqual(response.json(), {"jobs": self.rows[:20], "has_more": True})
            request = self.requests[-1]
            self.assertEqual(request.url.params["status"], statuses)
            self.assertEqual(request.url.params["offset"], "20")
            self.assertEqual(request.headers["authorization"], "Bearer owner-token")

    def test_results_require_an_accessible_terminal_job(self):
        self.client.cookies.set(ACCESS, "owner-token")
        job = str(uuid4())
        path = f"/api/jobs/{job}/result"
        self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0].url.params["id"], "eq." + job)
        self.rows = [{"result_filename": "output.txt"}]
        self.assertEqual(self.client.get(path).content, b"job output")
        self.assertEqual(self.requests[-1].headers["authorization"], "Bearer owner-token")
