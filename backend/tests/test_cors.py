"""CORS behaviour of the real app.

TestClient without a `with` block skips startup events, so no services start.
"""

from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def preflight(origin: str):
    return client.options(
        "/analyze/",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
    )


def test_production_origin_is_allowed():
    response = preflight("https://legalyze-ai.vercel.app")

    assert (
        response.headers["access-control-allow-origin"]
        == "https://legalyze-ai.vercel.app"
    )


def test_other_vercel_site_is_not_allowed():
    response = preflight("https://evil.vercel.app")

    assert "access-control-allow-origin" not in response.headers
