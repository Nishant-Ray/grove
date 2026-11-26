import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from app import pricing
from app.accounts import ACCESS, admin, upstream
from app.main import app
from tests.test_marketplace import candidate


class ReviewsTest(unittest.TestCase):
    def setUp(self):
        self.job_id = str(uuid4())
        self.requests = []
        self.insert = (201, [{"id": str(uuid4()), "reviewer_role": "renter", "rating": 5, "comment": "Great", "created_at": "now"}])
        self.reputation = [{"display_name": "Hana", "host_rating": 4.5, "host_reviews": 2, "jobs_completed": 3,
                            "completion_rate": 0.75, "renter_rating": None, "renter_reviews": 0}]
        self.received = [{"id": str(uuid4()), "job_id": str(uuid4()), "reviewer_name": "Rae", "reviewer_role": "renter",
                          "rating": 5, "comment": "Great", "created_at": "2026-11-26T10:00:00Z"}]
        finished = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        self.job = {"id": self.job_id, "name": "Train", "status": "completed", "accepted_at": finished, "finished_at": finished}
        self.job_reviews = []
        self.candidates = []

        def handle(request):
            self.requests.append(request)
            path = request.url.path
            if path == "/auth/v1/user":
                return httpx.Response(200, json={"id": str(uuid4())})
            if path == "/rest/v1/reviews" and request.method == "POST":
                status, body = self.insert
                return httpx.Response(status, json=body)
            if path == "/rest/v1/reviews":
                return httpx.Response(200, json=self.job_reviews)
            if path == "/rest/v1/rpc/reputation":
                return httpx.Response(200, json=self.reputation)
            if path == "/rest/v1/rpc/reviews_received":
                return httpx.Response(200, json=self.received)
            if path == "/rest/v1/compute_jobs":
                return httpx.Response(200, json=[self.job])
            if path == "/rest/v1/rpc/job_participants":
                return httpx.Response(200, json=[{"role": "renter", "renter_name": "Rae", "host_name": "Hana", "device_name": "Lab"}])
            if path == "/rest/v1/rpc/job_thread_open":
                return httpx.Response(200, json=True)
            if path == "/rest/v1/rpc/recommend_hosts":
                return httpx.Response(200, json=self.candidates)
            return httpx.Response(200, json=[])

        async def fake():
            async with httpx.AsyncClient(base_url="https://test.invalid", transport=httpx.MockTransport(handle)) as client:
                yield client

        app.dependency_overrides[upstream] = fake
        app.dependency_overrides[admin] = fake
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app, headers={"X-Grove-Request": "1"})
        self.addCleanup(self.client.close)
        self.client.cookies.set(ACCESS, "user-token")

    def last(self, path, method=None):
        return [r for r in self.requests if r.url.path == path and (method is None or r.method == method)][-1]

    # Writing reviews ---------------------------------------------------------------------------------
    def test_review_sends_only_job_rating_and_comment(self):
        result = self.client.post(f"/api/jobs/{self.job_id}/review",
                                  json={"rating": 5, "comment": "  Great  ", "reviewee_id": str(uuid4()), "reviewer_id": "x"})
        self.assertEqual(result.status_code, 201, result.text)
        sent = self.last("/rest/v1/reviews", "POST")
        self.assertEqual(json.loads(sent.content), {"job_id": self.job_id, "rating": 5, "comment": "Great"})
        self.assertEqual(sent.headers["authorization"], "Bearer user-token")

    def test_review_is_not_mistaken_for_a_job_action(self):
        # Regression guard: POST /api/jobs/{id}/review must reach the reviews router.
        self.assertEqual(self.client.post(f"/api/jobs/{self.job_id}/review", json={"rating": 4}).status_code, 201)

    def test_review_validation(self):
        for body in ({"rating": 0}, {"rating": 6}, {"rating": 4.5}, {"rating": 4, "comment": "x" * 1001}, {}):
            self.assertEqual(self.client.post(f"/api/jobs/{self.job_id}/review", json=body).status_code, 422, body)
        self.assertEqual(len([r for r in self.requests if r.url.path == "/rest/v1/reviews"]), 0)

    def test_database_refusals(self):
        self.insert = (409, {"code": "23505", "message": "duplicate key"})
        result = self.client.post(f"/api/jobs/{self.job_id}/review", json={"rating": 4})
        self.assertEqual((result.status_code, result.json()["detail"]), (409, "You already reviewed this job."))
        self.insert = (403, {"code": "42501", "message": "NOT_REVIEWABLE"})
        result = self.client.post(f"/api/jobs/{self.job_id}/review", json={"rating": 4})
        self.assertEqual(result.status_code, 403)
        self.assertIn("14 days", result.json()["detail"])

    # Job page review state -------------------------------------------------------------------------------
    def test_job_detail_review_state(self):
        state = self.client.get(f"/api/jobs/{self.job_id}").json()["reviews"]
        self.assertEqual(state, {"mine": None, "theirs": None, "can_review": True})
        self.job_reviews = [{"reviewer_role": "host", "rating": 4, "comment": "Clear instructions", "created_at": "x"}]
        state = self.client.get(f"/api/jobs/{self.job_id}").json()["reviews"]
        self.assertEqual((state["theirs"]["rating"], state["can_review"]), (4, True))
        self.job_reviews.append({"reviewer_role": "renter", "rating": 5, "comment": "", "created_at": "x"})
        state = self.client.get(f"/api/jobs/{self.job_id}").json()["reviews"]
        self.assertEqual((state["mine"]["rating"], state["can_review"]), (5, False))

    def test_cannot_review_outside_window_or_unfinished(self):
        self.job["finished_at"] = (datetime.now(timezone.utc) - timedelta(days=15)).isoformat()
        self.assertFalse(self.client.get(f"/api/jobs/{self.job_id}").json()["reviews"]["can_review"])
        self.job.update(status="running", finished_at=None)
        self.assertFalse(self.client.get(f"/api/jobs/{self.job_id}").json()["reviews"]["can_review"])

    # Profiles ---------------------------------------------------------------------------------------------
    def test_profile(self):
        user = str(uuid4())
        body = self.client.get(f"/api/users/{user}/profile").json()
        self.assertEqual(body["display_name"], "Hana")
        self.assertEqual(body["host"], {"rating": 4.5, "reviews": 2, "jobs_completed": 3, "completion_rate": 0.75})
        self.assertNotIn("job_id", body["reviews"][0])
        self.assertEqual(json.loads(self.last("/rest/v1/rpc/reputation").content), {"p_users": [user]})
        self.reputation = []
        self.assertEqual(self.client.get(f"/api/users/{user}/profile").status_code, 404)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(f"/api/users/{user}/profile").status_code, 401)

    # Ratings in recommendations ----------------------------------------------------------------------------
    def test_rating_sort_and_reliability_inputs(self):
        self.candidates = [candidate("new", 0.20), candidate("good", 0.30, rating=4.6, reviews=12),
                           candidate("great", 0.35, rating=4.9, reviews=3), candidate("tied", 0.25, rating=4.6, reviews=30)]
        seen = []
        real = pricing.reliability
        with patch("app.quotes.pricing.reliability", side_effect=lambda stats=None: seen.append(stats) or real(stats)):
            body = self.client.get("/api/hosts/recommendations", params={"sort": "rating"}).json()
        self.assertEqual([h["device_name"] for h in body["hosts"]], ["great", "tied", "good", "new"])
        self.assertEqual(body["hosts"][0]["rating"], 4.9)
        self.assertEqual(body["hosts"][-1]["rating"], None)
        self.assertIn({"host_rating": 4.9, "host_reviews": 3, "jobs_completed": 3, "completion_rate": None}, seen)
        self.assertEqual(body["hosts"][0]["rate_per_hr"], "0.4550", "reliability stays 1.0 until enabled")
