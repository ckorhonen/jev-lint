from fastapi.testclient import TestClient

from app.main import app


def test_health_returns_ok():
    client = TestClient(app)
    assert client.get("/health").json() == {"status": "ok"}
