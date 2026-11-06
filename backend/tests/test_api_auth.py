"""The API router must only serve callers holding the shared secret."""

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import api
from app import app
from config import settings
from infrastructure import rate_limiter

SECRET = "test-shared-secret"
UPLOAD = {"file": ("contract.txt", b"This agreement binds both parties.", "text/plain")}
ENDPOINTS = ["/demo/", "/analyze/"]


class FakeRedis:
    """Records the keys the rate limiter consumes."""

    def __init__(self):
        self.keys = []

    async def incr(self, key):
        self.keys.append(key)
        return 1

    async def expire(self, key, seconds):
        return True


@pytest.fixture
def pipeline_calls(monkeypatch):
    calls = []

    async def fake_pipeline(text, filename, session_id):
        calls.append(filename)
        yield 'data: {"step": "done"}\n\n'

    monkeypatch.setattr(api, "run_demo_pipeline", fake_pipeline)
    monkeypatch.setattr(api, "run_enhanced_pipeline_streamed", fake_pipeline)
    return calls


@pytest.fixture
def redis_client(monkeypatch):
    client = FakeRedis()
    monkeypatch.setattr(rate_limiter, "client", client)
    return client


@pytest.fixture
def configured_secret(monkeypatch):
    monkeypatch.setattr(settings.backend_auth, "secret", SECRET)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_missing_secret_header_is_rejected(client, configured_secret, pipeline_calls, endpoint):
    response = client.post(endpoint, files=UPLOAD)

    assert response.status_code == 401
    assert pipeline_calls == []


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_unauthenticated_request_without_a_file_gets_401_not_a_validation_error(
    client, configured_secret, endpoint
):
    assert client.post(endpoint).status_code == 401


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("wrong", ["wrong-secret", "", "café"])
def test_wrong_secret_is_rejected(client, configured_secret, pipeline_calls, endpoint, wrong):
    response = client.post(
        endpoint, files=UPLOAD, headers={"X-Internal-Secret": wrong.encode("latin-1")}
    )

    assert response.status_code == 401
    assert pipeline_calls == []


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_server_without_a_secret_refuses_every_request(
    client, monkeypatch, pipeline_calls, endpoint
):
    monkeypatch.setattr(settings.backend_auth, "secret", "")

    # An empty header must not match an empty configured secret.
    for headers in ({}, {"X-Internal-Secret": ""}, {"X-Internal-Secret": "anything"}):
        response = client.post(endpoint, files=UPLOAD, headers=headers)
        assert response.status_code == 503

    assert pipeline_calls == []


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_correct_secret_streams_the_pipeline(client, configured_secret, pipeline_calls, endpoint):
    response = client.post(endpoint, files=UPLOAD, headers={"X-Internal-Secret": SECRET})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert 'data: {"step": "done"}' in response.text
    assert pipeline_calls == ["contract.txt"]


def test_spoofed_forwarded_ip_without_secret_never_reaches_the_limiter(
    client, configured_secret, pipeline_calls, redis_client
):
    response = client.post(
        "/demo/", files=UPLOAD, headers={"X-Forwarded-For": "198.51.100.77"}
    )

    assert response.status_code == 401
    assert redis_client.keys == []


def test_limiter_keys_on_forwarded_ip_for_authenticated_caller(
    client, configured_secret, pipeline_calls, redis_client
):
    response = client.post(
        "/demo/",
        files=UPLOAD,
        headers={"X-Internal-Secret": SECRET, "X-Forwarded-For": "203.0.113.9, 10.0.0.1"},
    )

    assert response.status_code == 200
    assert redis_client.keys == ["ratelimit:demo:203.0.113.9"]


@pytest.mark.parametrize("path", ["/", "/health"])
def test_service_info_endpoints_stay_public(client, configured_secret, path):
    assert client.get(path).status_code == 200


def test_secret_is_read_from_the_environment(monkeypatch):
    monkeypatch.setenv("BACKEND_API_SECRET", "from-environment")
    # A private copy, so the shared `settings` object stays untouched.
    path = Path(__file__).parent.parent / "config" / "settings.py"
    spec = importlib.util.spec_from_file_location("settings_under_test", path)
    module = importlib.util.module_from_spec(spec)
    # dataclass resolves its module through sys.modules
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)

    assert module.AppConfig().backend_auth.secret == "from-environment"
    assert module.AppConfig().backend_auth.is_configured is True
