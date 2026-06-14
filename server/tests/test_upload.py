"""Tests for file upload endpoints — multipart and resumable (tus-lite)."""

import hashlib
import pytest
import server.main as main_mod


def _upload(client, pid, path, content, headers, **params):
    return client.post(
        f"/projects/{pid}/files/upload",
        params={"path": path, **params},
        files={"file": (path.split("/")[-1], content, "application/octet-stream")},
        headers=headers,
    )


def _second_member(client, token):
    r = client.post(
        "/members", json={"name": "locker"},
        headers={"X-Admin-Token": token},
    )
    assert r.status_code == 201, r.text
    d = r.json()
    return {"X-Member-Name": d["name"], "X-Api-Key": d["api_key"]}


# ── Multipart upload ──────────────────────────────────────────────────────────

def test_upload_creates_new_file_at_version_1(app_client, member, project):
    pid = project["id"]
    r = _upload(app_client, pid, "Assets/hero.fbx", b"FBX data", member["headers"])
    assert r.status_code == 200
    body = r.json()
    assert body["path"] == "Assets/hero.fbx"
    assert body["current_version"] == 1


def test_upload_second_time_increments_version(app_client, member, project):
    pid = project["id"]
    _upload(app_client, pid, "Assets/hero.fbx", b"v1", member["headers"])
    r = _upload(app_client, pid, "Assets/hero.fbx", b"v2", member["headers"])
    assert r.status_code == 200
    assert r.json()["current_version"] == 2


def test_upload_locked_by_other_returns_423(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    pid = project["id"]
    locker_h = _second_member(app_client, "tok")

    _upload(app_client, pid, "Assets/model.fbx", b"data", member["headers"])
    app_client.post(
        f"/projects/{pid}/files/lock",
        json={"path": "Assets/model.fbx"},
        headers=locker_h,
    )

    r = _upload(app_client, pid, "Assets/model.fbx", b"new", member["headers"],
                base_version=1)
    assert r.status_code == 423
    assert r.json()["detail"]["locked_by"] == "locker"


def test_upload_stale_base_returns_409(app_client, member, project):
    pid = project["id"]
    _upload(app_client, pid, "Assets/f.txt", b"v1", member["headers"])
    _upload(app_client, pid, "Assets/f.txt", b"v2", member["headers"])

    r = _upload(app_client, pid, "Assets/f.txt", b"v3 stale", member["headers"],
                base_version=1)
    assert r.status_code == 409
    assert r.json()["detail"]["server_version"] == 2


def test_upload_force_true_bypasses_409(app_client, member, project):
    pid = project["id"]
    _upload(app_client, pid, "Assets/f.txt", b"v1", member["headers"])
    _upload(app_client, pid, "Assets/f.txt", b"v2", member["headers"])

    r = _upload(app_client, pid, "Assets/f.txt", b"forced", member["headers"],
                base_version=1, force=True)
    assert r.status_code == 200
    assert r.json()["current_version"] == 3


# ── Resumable upload (tus-lite) ───────────────────────────────────────────────

def _resumable_init(client, pid, path, size, headers, **params):
    return client.post(
        f"/projects/{pid}/files/upload/init",
        params={"path": path, "size": size, **params},
        headers=headers,
    )


def _resumable_patch(client, pid, uid, offset, data, headers):
    return client.patch(
        f"/projects/{pid}/files/upload/{uid}",
        params={"offset": offset},
        content=data,
        headers={**headers, "Content-Type": "application/octet-stream"},
    )


def _resumable_complete(client, pid, uid, headers):
    return client.post(
        f"/projects/{pid}/files/upload/{uid}/complete",
        headers=headers,
    )


def test_resumable_init_locked_returns_423(app_client, member, project, monkeypatch):
    monkeypatch.setattr(main_mod, "ADMIN_TOKEN", "tok")
    pid = project["id"]
    locker_h = _second_member(app_client, "tok")

    _upload(app_client, pid, "Assets/x.bin", b"v1", member["headers"])
    app_client.post(
        f"/projects/{pid}/files/lock",
        json={"path": "Assets/x.bin"},
        headers=locker_h,
    )

    r = _resumable_init(app_client, pid, "Assets/x.bin", 5, member["headers"],
                        base_version=1)
    assert r.status_code == 423


def test_resumable_patch_wrong_offset_returns_409(app_client, member, project):
    pid = project["id"]
    r_init = _resumable_init(app_client, pid, "Assets/a.bin", 10, member["headers"])
    assert r_init.status_code == 200
    uid = r_init.json()["upload_id"]

    r = _resumable_patch(app_client, pid, uid, offset=5, data=b"hello", headers=member["headers"])
    assert r.status_code == 409
    assert r.json()["detail"]["offset"] == 0  # real offset is 0 (nothing written yet)


def test_resumable_complete_incomplete_upload_returns_400(app_client, member, project):
    pid = project["id"]
    data = b"hello world"
    r_init = _resumable_init(app_client, pid, "Assets/b.bin", len(data) + 5, member["headers"])
    uid = r_init.json()["upload_id"]

    # Send only part of the data
    _resumable_patch(app_client, pid, uid, 0, data, member["headers"])
    r = _resumable_complete(app_client, pid, uid, member["headers"])
    assert r.status_code == 400
    assert "Incomplete" in r.json()["detail"]


def test_resumable_full_flow_commits_version(app_client, member, project):
    pid = project["id"]
    data = b"binary content for resumable upload"
    expected_md5 = hashlib.md5(data).hexdigest()

    r_init = _resumable_init(app_client, pid, "Assets/c.bin", len(data), member["headers"])
    assert r_init.status_code == 200
    uid = r_init.json()["upload_id"]

    # Send in two chunks
    mid = len(data) // 2
    r1 = _resumable_patch(app_client, pid, uid, 0, data[:mid], member["headers"])
    assert r1.status_code == 200
    assert r1.json()["offset"] == mid

    r2 = _resumable_patch(app_client, pid, uid, mid, data[mid:], member["headers"])
    assert r2.status_code == 200
    assert r2.json()["offset"] == len(data)

    r_done = _resumable_complete(app_client, pid, uid, member["headers"])
    assert r_done.status_code == 200
    body = r_done.json()
    assert body["path"] == "Assets/c.bin"
    assert body["current_version"] == 1
    assert body["checksum"] == expected_md5
