"""Tests for per-project membership + roles (admin / member)."""

import server.main as main_mod
import server.storage as storage


def _register(client, name, token):
    """Register a member via the admin token (needed after the first member)."""
    r = client.post("/members", json={"name": name}, headers={"X-Admin-Token": token})
    assert r.status_code == 201, r.text
    d = r.json()
    return {"id": d["id"], "name": name, "headers": {"X-Member-Name": name, "X-Api-Key": d["api_key"]}}


def _upload(client, pid, path, content, headers):
    return client.post(
        f"/projects/{pid}/files/upload",
        params={"path": path},
        files={"file": (path.split("/")[-1], content, "application/octet-stream")},
        headers=headers,
    )


# ── Creator is admin; visibility is membership-scoped ─────────────────────────

def test_creator_is_project_admin(app_client, member, project):
    r = app_client.get("/projects", headers=member["headers"])
    assert r.status_code == 200
    mine = [p for p in r.json() if p["id"] == project["id"]]
    assert len(mine) == 1
    assert mine[0]["role"] == "admin"


def test_create_project_returns_admin_role(app_client, member):
    r = app_client.post("/projects", json={"name": "Solo"}, headers=member["headers"])
    assert r.status_code == 201
    assert r.json()["role"] == "admin"


def test_non_member_does_not_see_project(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    bob = _register(app_client, "bob", "tok")
    r = app_client.get("/projects", headers=bob["headers"])
    assert r.status_code == 200
    assert all(p["id"] != project["id"] for p in r.json())


def test_non_member_blocked_from_project_endpoints(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    bob = _register(app_client, "bob", "tok")
    pid = project["id"]
    for path in (f"/projects/{pid}/files", f"/projects/{pid}/activity", f"/projects/{pid}/stats"):
        r = app_client.get(path, headers=bob["headers"])
        assert r.status_code == 403, path


# ── Adding / managing members ─────────────────────────────────────────────────

def test_admin_adds_member_who_can_then_work(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    bob = _register(app_client, "bob", "tok")
    pid = project["id"]

    add = app_client.post(
        f"/projects/{pid}/members",
        json={"member_id": bob["id"], "role": "member"},
        headers=member["headers"],
    )
    assert add.status_code == 201, add.text

    # Bob now sees the project and can push to it.
    r = app_client.get("/projects", headers=bob["headers"])
    assert any(p["id"] == pid for p in r.json())
    up = _upload(app_client, pid, "Assets/bob.fbx", b"data", bob["headers"])
    assert up.status_code == 200


def test_member_cannot_manage_roles(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    bob = _register(app_client, "bob", "tok")
    carol = _register(app_client, "carol", "tok")
    pid = project["id"]
    app_client.post(f"/projects/{pid}/members", json={"member_id": bob["id"]}, headers=member["headers"])

    # Bob (plain member) cannot add Carol.
    r = app_client.post(
        f"/projects/{pid}/members",
        json={"member_id": carol["id"]},
        headers=bob["headers"],
    )
    assert r.status_code == 403


def test_promote_and_demote_member(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    bob = _register(app_client, "bob", "tok")
    pid = project["id"]
    app_client.post(f"/projects/{pid}/members", json={"member_id": bob["id"]}, headers=member["headers"])

    # Promote Bob → admin; he can now manage members.
    r = app_client.put(
        f"/projects/{pid}/members/{bob['id']}",
        json={"role": "admin"}, headers=member["headers"],
    )
    assert r.status_code == 200
    assert storage.get_project_role(pid, bob["id"]) == "admin"

    # Demote Bob back to member (creator is still admin, so it's allowed).
    r = app_client.put(
        f"/projects/{pid}/members/{bob['id']}",
        json={"role": "member"}, headers=member["headers"],
    )
    assert r.status_code == 200
    assert storage.get_project_role(pid, bob["id"]) == "member"


def test_cannot_demote_last_admin(app_client, member, project):
    pid = project["id"]
    r = app_client.put(
        f"/projects/{pid}/members/{member['id']}",
        json={"role": "member"}, headers=member["headers"],
    )
    assert r.status_code == 409


def test_cannot_remove_last_admin(app_client, member, project):
    pid = project["id"]
    r = app_client.delete(
        f"/projects/{pid}/members/{member['id']}", headers=member["headers"],
    )
    assert r.status_code == 409


def test_post_cannot_demote_last_admin(app_client, member, project):
    # Re-POSTing the sole admin with role 'member' must not bypass the guard (review #1).
    pid = project["id"]
    r = app_client.post(
        f"/projects/{pid}/members",
        json={"member_id": member["id"], "role": "member"}, headers=member["headers"],
    )
    assert r.status_code == 409
    assert storage.get_project_role(pid, member["id"]) == "admin"  # unchanged


def test_deactivated_admin_does_not_count_toward_last_admin(app_client, member, project, monkeypatch):
    # An admin whose account was deactivated must not keep the project's last active
    # admin from being protected (review #2).
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    bob = _register(app_client, "bob", "tok")
    pid = project["id"]
    # Bob is a second admin, then his account is deactivated (DELETE /members).
    app_client.post(f"/projects/{pid}/members", json={"member_id": bob["id"], "role": "admin"},
                    headers=member["headers"])
    r = app_client.delete(f"/members/{bob['id']}", headers={**member["headers"], "X-Admin-Token": "tok"})
    assert r.status_code == 200
    # The creator is now the sole *active* admin — demoting them must be blocked.
    r = app_client.put(
        f"/projects/{pid}/members/{member['id']}",
        json={"role": "member"}, headers=member["headers"],
    )
    assert r.status_code == 409


def test_remove_member(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    bob = _register(app_client, "bob", "tok")
    pid = project["id"]
    app_client.post(f"/projects/{pid}/members", json={"member_id": bob["id"]}, headers=member["headers"])

    r = app_client.delete(f"/projects/{pid}/members/{bob['id']}", headers=member["headers"])
    assert r.status_code == 200
    assert storage.get_project_role(pid, bob["id"]) is None
    # Bob no longer sees the project.
    r = app_client.get("/projects", headers=bob["headers"])
    assert all(p["id"] != pid for p in r.json())


def test_add_unknown_member_is_404(app_client, member, project):
    r = app_client.post(
        f"/projects/{project['id']}/members",
        json={"member_id": 9999}, headers=member["headers"],
    )
    assert r.status_code == 404


def test_invalid_role_is_422(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    bob = _register(app_client, "bob", "tok")
    r = app_client.post(
        f"/projects/{project['id']}/members",
        json={"member_id": bob["id"], "role": "superuser"}, headers=member["headers"],
    )
    assert r.status_code == 422


# ── Env super-admin (break-glass) ─────────────────────────────────────────────

def test_super_admin_sees_all_and_bypasses_membership(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    bob = _register(app_client, "bob", "tok")  # not a member of `project`
    pid = project["id"]
    h = {**bob["headers"], "X-Admin-Token": "tok"}

    # Sees every project despite no membership, each tagged role='admin' so the
    # web UI exposes admin controls (review #3).
    r = app_client.get("/projects", headers=h)
    seen = [p for p in r.json() if p["id"] == pid]
    assert len(seen) == 1
    assert seen[0]["role"] == "admin"
    # Passes the member gate on a project endpoint.
    r = app_client.get(f"/projects/{pid}/stats", headers=h)
    assert r.status_code == 200
    # Passes the admin gate (can manage members).
    r = app_client.post(f"/projects/{pid}/members", json={"member_id": bob["id"]}, headers=h)
    assert r.status_code == 201


# ── List members ──────────────────────────────────────────────────────────────

def test_list_project_members(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    bob = _register(app_client, "bob", "tok")
    pid = project["id"]
    app_client.post(f"/projects/{pid}/members", json={"member_id": bob["id"]}, headers=member["headers"])

    r = app_client.get(f"/projects/{pid}/members", headers=member["headers"])
    assert r.status_code == 200
    rows = {m["name"]: m["role"] for m in r.json()}
    assert rows[member["name"]] == "admin"
    assert rows["bob"] == "member"


# ── Migration backfill ────────────────────────────────────────────────────────

def test_migration_backfills_existing_projects(tmp_path):
    """A DB with projects + members but no project_members rows (pre-upgrade) gets
    backfilled on init_db: everyone becomes a member, the lowest-id member admin."""
    db = str(tmp_path / "legacy.db")
    storage.init_db(db)
    # Seed two members and a project, then wipe membership to simulate a pre-upgrade DB.
    storage.create_member("alice")
    storage.create_member("bob")
    storage.create_project("Legacy", "", "#fff", "")  # no creator_id → no membership row
    conn = storage._get_conn()
    conn.execute("DELETE FROM project_members")
    conn.commit()
    conn.close()

    storage.init_db(db)  # re-run migration

    pid = storage.list_projects()[0]["id"]
    members = {m["name"]: m for m in storage.list_members()}
    alice_id, bob_id = members["alice"]["id"], members["bob"]["id"]
    # Both are members; the lowest id (alice) is admin.
    assert storage.get_project_role(pid, alice_id) == "admin"
    assert storage.get_project_role(pid, bob_id) == "member"
