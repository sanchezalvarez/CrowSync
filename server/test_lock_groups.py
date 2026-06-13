"""Tests for lock-group behaviour (lock_group_id, unlock scope, grouped activity).

Run directly:  python -m server.test_lock_groups
"""

import os
import tempfile

# Isolated DB/storage before importing the app.
_tmp = tempfile.mkdtemp()
os.environ["CROWSYNC_DB_PATH"] = os.path.join(_tmp, "lg.db")
os.environ["CROWSYNC_STORAGE_ROOT"] = os.path.join(_tmp, "storage")

from fastapi.testclient import TestClient
from server.main import app

CLIENT: TestClient = None  # set in _run
_H = None


def _ok(r):
    assert r.status_code < 300, f"{r.status_code} {r.text}"
    return r


def _project(files):
    """Create a fresh project, upload `files` (dict path->bytes), return (pid, headers)."""
    pid = _ok(CLIENT.post("/projects", json={"name": "p"}, headers=_H)).json()["id"]
    for path, content in files.items():
        _ok(CLIENT.post(f"/projects/{pid}/files/upload", params={"path": path},
                        files={"file": (path.split("/")[-1], content, "application/octet-stream")}, headers=_H))
    return pid


def _files(pid):
    return {f["path"]: f for f in _ok(CLIENT.get(f"/projects/{pid}/files", headers=_H)).json()}


BASE = {
    "Assets/Models/door.fbx": b"FBX",
    "Assets/Models/door.fbx.meta": b"guid: 11111111111111111111111111111111",
    "Assets/Models/door.prefab": b"PREFAB",
    "ProjectSettings/x.txt": b"x",
}


def test_lock_assigns_shared_group_id():
    pid = _project(BASE)
    res = _ok(CLIENT.post(f"/projects/{pid}/files/lock", json={
        "path": "Assets/Models/door.fbx", "reason": "test",
        "also": ["Assets/Models/door.prefab"]}, headers=_H)).json()
    assert set(res["locked"]) == {
        "Assets/Models/door.fbx", "Assets/Models/door.fbx.meta", "Assets/Models/door.prefab"}
    gid = res["group_id"]
    assert gid
    f = _files(pid)
    for p in res["locked"]:
        assert f[p]["lock_group_id"] == gid, p
        assert f[p]["lock_reason"] == "test"
        assert f[p]["locked_by"]["name"] == "lubo"


def test_single_lock_has_no_group():
    pid = _project({"ProjectSettings/x.txt": b"x"})  # no .meta companion
    res = _ok(CLIENT.post(f"/projects/{pid}/files/lock",
                          json={"path": "ProjectSettings/x.txt"}, headers=_H)).json()
    assert res["group_id"] is None
    assert res["locked"] == ["ProjectSettings/x.txt"]
    assert _files(pid)["ProjectSettings/x.txt"]["lock_group_id"] is None


def test_lock_activity_is_grouped():
    pid = _project(BASE)
    _ok(CLIENT.post(f"/projects/{pid}/files/lock", json={
        "path": "Assets/Models/door.fbx", "reason": "pivot fix",
        "also": ["Assets/Models/door.prefab"]}, headers=_H))
    acts = _ok(CLIENT.get(f"/projects/{pid}/activity", headers=_H)).json()
    locks = [a for a in acts if a["action"] == "lock"]
    # Exactly one grouped lock activity, companions folded into the detail.
    assert len(locks) == 1, [a["detail"] for a in acts]
    detail = locks[0]["detail"]
    assert "door.fbx" in detail and "related" in detail and "pivot fix" in detail
    assert "door.fbx.meta" in detail
    # No separate per-companion rows.
    assert not any(a["action"] == "auto_lock_meta" for a in acts)


def test_unlock_scope_group_releases_all():
    pid = _project(BASE)
    _ok(CLIENT.post(f"/projects/{pid}/files/lock", json={
        "path": "Assets/Models/door.fbx", "also": ["Assets/Models/door.prefab"]}, headers=_H))
    _ok(CLIENT.post(f"/projects/{pid}/files/unlock",
                    json={"path": "Assets/Models/door.fbx", "scope": "group"}, headers=_H))
    f = _files(pid)
    for p in ["Assets/Models/door.fbx", "Assets/Models/door.fbx.meta", "Assets/Models/door.prefab"]:
        assert f[p]["locked_by_id"] is None, p
        assert f[p]["lock_group_id"] is None, p


def test_unlock_scope_file_keeps_rest_of_group():
    pid = _project(BASE)
    res = _ok(CLIENT.post(f"/projects/{pid}/files/lock", json={
        "path": "Assets/Models/door.fbx", "also": ["Assets/Models/door.prefab"]}, headers=_H)).json()
    gid = res["group_id"]
    # Unlock just the fbx — meta + prefab stay locked, still grouped (2 remain).
    _ok(CLIENT.post(f"/projects/{pid}/files/unlock",
                    json={"path": "Assets/Models/door.fbx", "scope": "file"}, headers=_H))
    f = _files(pid)
    assert f["Assets/Models/door.fbx"]["locked_by_id"] is None
    assert f["Assets/Models/door.fbx"]["lock_group_id"] is None
    assert f["Assets/Models/door.fbx.meta"]["locked_by_id"] is not None
    assert f["Assets/Models/door.fbx.meta"]["lock_group_id"] == gid
    assert f["Assets/Models/door.prefab"]["lock_group_id"] == gid


def test_group_collapses_to_single_clears_group_id():
    pid = _project(BASE)
    _ok(CLIENT.post(f"/projects/{pid}/files/lock", json={
        "path": "Assets/Models/door.fbx", "also": ["Assets/Models/door.prefab"]}, headers=_H))
    # Unlock two of three → the lone remaining locked file is no longer a group.
    _ok(CLIENT.post(f"/projects/{pid}/files/unlock",
                    json={"path": "Assets/Models/door.fbx", "scope": "file"}, headers=_H))
    _ok(CLIENT.post(f"/projects/{pid}/files/unlock",
                    json={"path": "Assets/Models/door.fbx.meta", "scope": "file"}, headers=_H))
    f = _files(pid)
    assert f["Assets/Models/door.prefab"]["locked_by_id"] is not None     # still locked
    assert f["Assets/Models/door.prefab"]["lock_group_id"] is None        # but no longer grouped


def _run():
    global CLIENT, _H
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    with TestClient(app) as c:
        CLIENT = c
        key = c.post("/members", json={"name": "lubo"}).json()["api_key"]
        _H = {"X-Member-Name": "lubo", "X-Api-Key": key}
        for t in tests:
            try:
                t()
                print(f"  ok   {t.__name__}")
            except AssertionError as e:
                failed += 1
                print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return failed == 0


if __name__ == "__main__":
    import sys
    sys.exit(0 if _run() else 1)
