"""Tests for authentication and admin-token authorization gates."""

import pytest
import server.main as main_mod


# ── Health endpoint (no auth) ─────────────────────────────────────────────────

def test_health_requires_no_auth(app_client):
    r = app_client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ── Authenticated endpoints reject missing / wrong credentials ────────────────

def test_missing_auth_headers_returns_422(app_client):
    # FastAPI rejects missing required Header(...) with 422 Unprocessable Entity
    r = app_client.get("/projects")
    assert r.status_code == 422


def test_wrong_api_key_returns_401(app_client):
    # Register a member first (bootstrap)
    r_reg = app_client.post("/members", json={"name": "alice"})
    assert r_reg.status_code == 201
    r = app_client.get(
        "/projects",
        headers={"X-Member-Name": "alice", "X-Api-Key": "wrongkey"},
    )
    assert r.status_code == 401


def test_unknown_member_returns_401(app_client):
    r = app_client.get(
        "/projects",
        headers={"X-Member-Name": "ghost", "X-Api-Key": "anykey"},
    )
    assert r.status_code == 401


# ── Bootstrap: first member needs no admin token ──────────────────────────────

def test_bootstrap_first_member_no_token_needed(app_client):
    r = app_client.post("/members", json={"name": "first"})
    assert r.status_code == 201
    assert "api_key" in r.json()


# ── Second member registration requires admin token ───────────────────────────

def test_second_member_without_admin_token_disabled(app_client):
    """ADMIN_TOKEN == '' → registration disabled after bootstrap."""
    app_client.post("/members", json={"name": "first"})
    r = app_client.post("/members", json={"name": "second"})
    assert r.status_code == 403
    assert "disabled" in r.json()["detail"].lower()


def test_second_member_wrong_token_returns_403(app_client, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "correct-token")
    app_client.post("/members", json={"name": "first"})
    r = app_client.post(
        "/members", json={"name": "second"},
        headers={"X-Admin-Token": "wrong-token"},
    )
    assert r.status_code == 403


def test_second_member_correct_token_returns_201(app_client, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "secret")
    app_client.post("/members", json={"name": "first"})
    r = app_client.post(
        "/members", json={"name": "second"},
        headers={"X-Admin-Token": "secret"},
    )
    assert r.status_code == 201
    assert "api_key" in r.json()


# ── Recovery: re-posting an existing name re-issues the key ──────────────────

def test_recovery_reissues_key_and_invalidates_old(app_client, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "secret")
    # Bootstrap first member
    r1 = app_client.post("/members", json={"name": "alice"})
    old_key = r1.json()["api_key"]

    # Re-register with admin token → new key issued
    r2 = app_client.post(
        "/members", json={"name": "alice"},
        headers={"X-Admin-Token": "secret"},
    )
    assert r2.status_code == 201
    new_key = r2.json()["api_key"]
    assert new_key != old_key

    # Old key no longer works
    r_old = app_client.get(
        "/projects",
        headers={"X-Member-Name": "alice", "X-Api-Key": old_key},
    )
    assert r_old.status_code == 401

    # New key works
    r_new = app_client.get(
        "/projects",
        headers={"X-Member-Name": "alice", "X-Api-Key": new_key},
    )
    assert r_new.status_code == 200


# ── Destructive endpoints require strict admin token ──────────────────────────

def test_delete_project_no_admin_token_returns_403(app_client, member, project):
    r = app_client.delete(
        f"/projects/{project['id']}",
        headers=member["headers"],
    )
    assert r.status_code == 403


def test_delete_project_correct_admin_token_succeeds(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "admin")
    r = app_client.delete(
        f"/projects/{project['id']}",
        headers={**member["headers"], "X-Admin-Token": "admin"},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
