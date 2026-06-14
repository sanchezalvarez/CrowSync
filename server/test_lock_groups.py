"""Tests for lock-group behaviour (lock_group_id, unlock scope, grouped activity).

Run directly:  python -m server.test_lock_groups
Run with pytest:  pytest server/test_lock_groups.py
"""

import pytest

BASE = {
    "Assets/Models/door.fbx": b"FBX",
    "Assets/Models/door.fbx.meta": b"guid: 11111111111111111111111111111111",
    "Assets/Models/door.prefab": b"PREFAB",
    "ProjectSettings/x.txt": b"x",
}


def _upload_files(client, pid, files, headers):
    for path, content in files.items():
        r = client.post(
            f"/projects/{pid}/files/upload",
            params={"path": path},
            files={"file": (path.split("/")[-1], content, "application/octet-stream")},
            headers=headers,
        )
        assert r.status_code == 200, f"upload {path}: {r.text}"


def _project_with_files(client, member, files=None):
    r = client.post("/projects", json={"name": "p"}, headers=member["headers"])
    assert r.status_code == 201
    pid = r.json()["id"]
    _upload_files(client, pid, files or BASE, member["headers"])
    return pid


def _files(client, pid, headers):
    r = client.get(f"/projects/{pid}/files", headers=headers)
    assert r.status_code == 200
    return {f["path"]: f for f in r.json()}


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_lock_assigns_shared_group_id(app_client, member):
    pid = _project_with_files(app_client, member)
    res = app_client.post(
        f"/projects/{pid}/files/lock",
        json={"path": "Assets/Models/door.fbx", "reason": "test",
              "also": ["Assets/Models/door.prefab"]},
        headers=member["headers"],
    ).json()
    assert set(res["locked"]) == {
        "Assets/Models/door.fbx",
        "Assets/Models/door.fbx.meta",
        "Assets/Models/door.prefab",
    }
    gid = res["group_id"]
    assert gid
    f = _files(app_client, pid, member["headers"])
    for p in res["locked"]:
        assert f[p]["lock_group_id"] == gid, p
        assert f[p]["lock_reason"] == "test"
        assert f[p]["locked_by"]["name"] == member["name"]


def test_single_lock_has_no_group(app_client, member):
    pid = _project_with_files(app_client, member, {"ProjectSettings/x.txt": b"x"})
    res = app_client.post(
        f"/projects/{pid}/files/lock",
        json={"path": "ProjectSettings/x.txt"},
        headers=member["headers"],
    ).json()
    assert res["group_id"] is None
    assert res["locked"] == ["ProjectSettings/x.txt"]
    assert _files(app_client, pid, member["headers"])["ProjectSettings/x.txt"]["lock_group_id"] is None


def test_lock_activity_is_grouped(app_client, member):
    pid = _project_with_files(app_client, member)
    app_client.post(
        f"/projects/{pid}/files/lock",
        json={"path": "Assets/Models/door.fbx", "reason": "pivot fix",
              "also": ["Assets/Models/door.prefab"]},
        headers=member["headers"],
    )
    acts = app_client.get(f"/projects/{pid}/activity", headers=member["headers"]).json()
    locks = [a for a in acts if a["action"] == "lock"]
    assert len(locks) == 1, [a["detail"] for a in acts]
    detail = locks[0]["detail"]
    assert "door.fbx" in detail and "related" in detail and "pivot fix" in detail
    assert "door.fbx.meta" in detail
    assert not any(a["action"] == "auto_lock_meta" for a in acts)


def test_unlock_scope_group_releases_all(app_client, member):
    pid = _project_with_files(app_client, member)
    app_client.post(
        f"/projects/{pid}/files/lock",
        json={"path": "Assets/Models/door.fbx", "also": ["Assets/Models/door.prefab"]},
        headers=member["headers"],
    )
    app_client.post(
        f"/projects/{pid}/files/unlock",
        json={"path": "Assets/Models/door.fbx", "scope": "group"},
        headers=member["headers"],
    )
    f = _files(app_client, pid, member["headers"])
    for p in ["Assets/Models/door.fbx", "Assets/Models/door.fbx.meta", "Assets/Models/door.prefab"]:
        assert f[p]["locked_by_id"] is None, p
        assert f[p]["lock_group_id"] is None, p


def test_unlock_scope_file_keeps_rest_of_group(app_client, member):
    pid = _project_with_files(app_client, member)
    res = app_client.post(
        f"/projects/{pid}/files/lock",
        json={"path": "Assets/Models/door.fbx", "also": ["Assets/Models/door.prefab"]},
        headers=member["headers"],
    ).json()
    gid = res["group_id"]
    app_client.post(
        f"/projects/{pid}/files/unlock",
        json={"path": "Assets/Models/door.fbx", "scope": "file"},
        headers=member["headers"],
    )
    f = _files(app_client, pid, member["headers"])
    assert f["Assets/Models/door.fbx"]["locked_by_id"] is None
    assert f["Assets/Models/door.fbx"]["lock_group_id"] is None
    assert f["Assets/Models/door.fbx.meta"]["locked_by_id"] is not None
    assert f["Assets/Models/door.fbx.meta"]["lock_group_id"] == gid
    assert f["Assets/Models/door.prefab"]["lock_group_id"] == gid


def test_group_collapses_to_single_clears_group_id(app_client, member):
    pid = _project_with_files(app_client, member)
    app_client.post(
        f"/projects/{pid}/files/lock",
        json={"path": "Assets/Models/door.fbx", "also": ["Assets/Models/door.prefab"]},
        headers=member["headers"],
    )
    for path in ["Assets/Models/door.fbx", "Assets/Models/door.fbx.meta"]:
        app_client.post(
            f"/projects/{pid}/files/unlock",
            json={"path": path, "scope": "file"},
            headers=member["headers"],
        )
    f = _files(app_client, pid, member["headers"])
    assert f["Assets/Models/door.prefab"]["locked_by_id"] is not None
    assert f["Assets/Models/door.prefab"]["lock_group_id"] is None


# ── Standalone runner (backwards compat) ─────────────────────────────────────

def _run():
    """Keep the old direct-run mode working alongside pytest."""
    import os
    import tempfile
    _tmp = tempfile.mkdtemp()
    os.environ["CROWSYNC_DB_PATH"] = os.path.join(_tmp, "lg.db")
    os.environ["CROWSYNC_STORAGE_ROOT"] = os.path.join(_tmp, "storage")

    from fastapi.testclient import TestClient
    import server.main as main_mod
    import server.storage as storage

    storage.init_db(os.environ["CROWSYNC_DB_PATH"])
    main_mod.DB_PATH = os.environ["CROWSYNC_DB_PATH"]
    main_mod.STORAGE_ROOT = os.environ["CROWSYNC_STORAGE_ROOT"]

    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    with TestClient(main_mod.app) as c:
        key = c.post("/members", json={"name": "lubo"}).json()["api_key"]
        _member = {
            "id": 1, "name": "lubo", "api_key": key,
            "headers": {"X-Member-Name": "lubo", "X-Api-Key": key},
        }
        for t in tests:
            try:
                t(c, _member)
                print(f"  ok   {t.__name__}")
            except Exception as e:
                failed += 1
                print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return failed == 0


if __name__ == "__main__":
    import sys
    sys.exit(0 if _run() else 1)
