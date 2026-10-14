"""服務骨架測試（不需要 Ollama：以假函式取代連線檢查）。"""
import pytest
from fastapi.testclient import TestClient

from app import main, ollama_client

GOOD_ORIGIN = "http://localhost:5500"
BAD_ORIGIN = "https://evil.example.com"


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


def fake_ollama(ok: bool, ready: bool):
    async def _check(timeout: float = 3.0):
        return ok, ready
    return _check


def test_health_ok(client, monkeypatch):
    monkeypatch.setattr(ollama_client, "check_model", fake_ollama(True, True))
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True and body["locations"] > 0


def test_health_ollama_down_returns_503(client, monkeypatch):
    monkeypatch.setattr(ollama_client, "check_model", fake_ollama(False, False))
    res = client.get("/health")
    assert res.status_code == 503
    assert res.json()["ok"] is False and res.json()["ollama"] is False


def test_cors_allows_whitelisted_origin(client, monkeypatch):
    monkeypatch.setattr(ollama_client, "check_model", fake_ollama(True, True))
    res = client.get("/health", headers={"Origin": GOOD_ORIGIN})
    assert res.headers.get("access-control-allow-origin") == GOOD_ORIGIN


def test_cors_blocks_other_origin(client, monkeypatch):
    monkeypatch.setattr(ollama_client, "check_model", fake_ollama(True, True))
    res = client.get("/health", headers={"Origin": BAD_ORIGIN})
    assert "access-control-allow-origin" not in res.headers
    pre = client.options("/health", headers={"Origin": BAD_ORIGIN, "Access-Control-Request-Method": "POST"})
    assert pre.status_code == 400


def test_error_format_404(client):
    res = client.get("/no-such-path")
    assert res.status_code == 404
    assert res.json() == {"error": "Not Found", "code": "not_found"}


def test_security_headers(client, monkeypatch):
    monkeypatch.setattr(ollama_client, "check_model", fake_ollama(True, True))
    res = client.get("/health")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"


def test_docs_hidden_by_default(client):
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_config_rejects_wildcard_origin():
    from app import config
    with pytest.raises(ValueError):
        config._origins("*")
    with pytest.raises(ValueError):
        config._ollama_host("http://attacker.example.com:11434")
