"""Shared pytest fixtures for CrowSync server tests."""

import pytest
import server.storage as storage
import server.main as main_mod
from fastapi.testclient import TestClient


@pytest.fixture()
def tmp_db(tmp_path):
    """Isolated SQLite DB for direct storage tests (no HTTP layer)."""
    db = str(tmp_path / "test.db")
    storage.init_db(db)
    return db


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    """TestClient wired to a fresh isolated DB + storage dir per test."""
    from collections import defaultdict
    db = str(tmp_path / "test.db")
    storage_root = str(tmp_path / "storage")
    monkeypatch.setattr(main_mod, "DB_PATH", db)
    monkeypatch.setattr(main_mod, "STORAGE_ROOT", storage_root)
    # ADMIN_TOKEN defaults to "" so bootstrap works without patching
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "")
    # Reset the in-memory rate-limiter so tests don't bleed hits into each other
    monkeypatch.setattr(main_mod, "_members_hits", defaultdict(list))
    with TestClient(main_mod.app) as client:
        yield client


@pytest.fixture()
def member(app_client):
    """Bootstrap the first member (no admin token needed) and return auth info."""
    r = app_client.post("/members", json={"name": "tester"})
    assert r.status_code == 201, r.text
    d = r.json()
    return {
        "id": d["id"],
        "name": d["name"],
        "api_key": d["api_key"],
        "headers": {"X-Member-Name": d["name"], "X-Api-Key": d["api_key"]},
    }


@pytest.fixture()
def project(app_client, member):
    """Create a project and return its data dict."""
    r = app_client.post(
        "/projects", json={"name": "test-proj"}, headers=member["headers"]
    )
    assert r.status_code == 201, r.text
    return r.json()
