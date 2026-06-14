"""Tests for POST /projects/{id}/compare — the core client-side sync diff logic."""

import hashlib
import pytest


def _md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def _upload(client, pid, path, content, headers):
    """Helper: multipart upload via the legacy browser endpoint."""
    return client.post(
        f"/projects/{pid}/files/upload",
        params={"path": path},
        files={"file": (path.split("/")[-1], content, "application/octet-stream")},
        headers=headers,
    )


def _compare(client, pid, entries, headers, tombstones=None):
    return client.post(
        f"/projects/{pid}/compare",
        json={"files": entries, "tombstones": tombstones or []},
        headers=headers,
    )


# ── Basic diff categories ─────────────────────────────────────────────────────

def test_compare_file_only_on_client_is_new_local(app_client, member, project):
    pid = project["id"]
    r = _compare(
        app_client, pid,
        [{"path": "Assets/hero.fbx", "checksum": "abc", "size_bytes": 3,
          "base_version": 0, "base_checksum": ""}],
        member["headers"],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["new_local"] == 1
    assert body["new_local"][0]["path"] == "Assets/hero.fbx"


def test_compare_file_only_on_server_is_new_remote(app_client, member, project):
    pid = project["id"]
    _upload(app_client, pid, "Assets/remote.fbx", b"server data", member["headers"])
    # Send empty manifest
    r = _compare(app_client, pid, [], member["headers"])
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["new_remote"] == 1
    assert body["new_remote"][0]["path"] == "Assets/remote.fbx"


def test_compare_matching_checksum_is_synced(app_client, member, project):
    pid = project["id"]
    content = b"in sync"
    _upload(app_client, pid, "Assets/sync.txt", content, member["headers"])
    r = _compare(
        app_client, pid,
        [{"path": "Assets/sync.txt", "checksum": _md5(content),
          "size_bytes": len(content), "base_version": 1, "base_checksum": _md5(content)}],
        member["headers"],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["synced"] == 1


def test_compare_local_changed_server_unchanged_is_modified_local(app_client, member, project):
    pid = project["id"]
    original = b"original"
    _upload(app_client, pid, "Assets/file.txt", original, member["headers"])
    server_checksum = _md5(original)

    # Client has a different checksum, but base matches server v1
    local_checksum = _md5(b"locally modified")
    r = _compare(
        app_client, pid,
        [{"path": "Assets/file.txt", "checksum": local_checksum,
          "size_bytes": 16, "base_version": 1, "base_checksum": server_checksum}],
        member["headers"],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["modified_local"] == 1
    assert body["modified_local"][0]["path"] == "Assets/file.txt"


def test_compare_server_updated_local_unchanged_is_behind(app_client, member, project):
    pid = project["id"]
    v1 = b"version one"
    v2 = b"version two"
    _upload(app_client, pid, "Assets/file.txt", v1, member["headers"])
    # Upload v2 so server is at version 2
    _upload(app_client, pid, "Assets/file.txt", v2, member["headers"])

    # Client still has v1 content, base was v1
    r = _compare(
        app_client, pid,
        [{"path": "Assets/file.txt", "checksum": _md5(v1),
          "size_bytes": len(v1), "base_version": 1, "base_checksum": _md5(v1)}],
        member["headers"],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["behind"] == 1
    assert body["behind"][0]["path"] == "Assets/file.txt"
    assert body["behind"][0]["server_version"] == 2


def test_compare_both_changed_is_conflict(app_client, member, project):
    pid = project["id"]
    v1 = b"version one"
    v2 = b"server updated"
    _upload(app_client, pid, "Assets/file.txt", v1, member["headers"])
    _upload(app_client, pid, "Assets/file.txt", v2, member["headers"])

    # Client also changed (different from both v1 and v2), base was v1
    local_checksum = _md5(b"client edit")
    r = _compare(
        app_client, pid,
        [{"path": "Assets/file.txt", "checksum": local_checksum,
          "size_bytes": 11, "base_version": 1, "base_checksum": _md5(v1)}],
        member["headers"],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["conflict"] == 1


def test_compare_no_base_recorded_is_conflict(app_client, member, project):
    pid = project["id"]
    _upload(app_client, pid, "Assets/file.txt", b"server v1", member["headers"])

    # Client has a different checksum but no sync base (base_version=0)
    r = _compare(
        app_client, pid,
        [{"path": "Assets/file.txt", "checksum": _md5(b"different"),
          "size_bytes": 9, "base_version": 0, "base_checksum": ""}],
        member["headers"],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["conflict"] == 1


def test_compare_unity_project_detected(app_client, member, project):
    pid = project["id"]
    r = _compare(
        app_client, pid,
        [
            {"path": "Assets/hero.fbx", "checksum": "a", "size_bytes": 1,
             "base_version": 0, "base_checksum": ""},
            {"path": "ProjectSettings/ProjectVersion.txt", "checksum": "b", "size_bytes": 1,
             "base_version": 0, "base_checksum": ""},
        ],
        member["headers"],
    )
    assert r.status_code == 200
    assert r.json()["unity"]["is_unity"] is True


# ── Delete propagation (D1) ───────────────────────────────────────────────────

def test_compare_tombstone_unchanged_server_is_deleted_local(app_client, member, project):
    """Client deleted a file it had synced; server still has it unchanged → the
    delete should propagate to the server (deleted_local)."""
    pid = project["id"]
    content = b"to be deleted"
    _upload(app_client, pid, "Assets/gone.fbx", content, member["headers"])
    r = _compare(
        app_client, pid, [], member["headers"],
        tombstones=[{"path": "Assets/gone.fbx", "base_version": 1, "base_checksum": _md5(content)}],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["deleted_local"] == 1
    assert body["deleted_local"][0]["path"] == "Assets/gone.fbx"
    # Must NOT also show up as new_remote.
    assert body["summary"]["new_remote"] == 0


def test_compare_tombstone_changed_server_is_conflict(app_client, member, project):
    """Client deleted a file but the server moved it meanwhile → delete-vs-edit
    conflict, not a silent delete."""
    pid = project["id"]
    _upload(app_client, pid, "Assets/edited.fbx", b"v1", member["headers"])
    _upload(app_client, pid, "Assets/edited.fbx", b"v2", member["headers"])  # server now v2
    r = _compare(
        app_client, pid, [], member["headers"],
        tombstones=[{"path": "Assets/edited.fbx", "base_version": 1, "base_checksum": _md5(b"v1")}],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["conflict"] == 1
    assert body["summary"]["deleted_local"] == 0


def test_compare_server_deleted_local_unchanged_is_deleted_remote(app_client, member, project):
    """File is on the client with a recorded base + unchanged content, but the server
    no longer has it → the server deleted it; remove the local leftover (deleted_remote)."""
    pid = project["id"]
    content = b"orphan"
    r = _compare(
        app_client, pid,
        [{"path": "Assets/orphan.fbx", "checksum": _md5(content), "size_bytes": len(content),
          "base_version": 3, "base_checksum": _md5(content)}],
        member["headers"],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["deleted_remote"] == 1
    assert body["deleted_remote"][0]["path"] == "Assets/orphan.fbx"
    assert body["summary"]["new_local"] == 0


def test_compare_server_absent_but_local_modified_is_new_local(app_client, member, project):
    """Same as above but the client's content changed since the base → the user has
    new work; re-add it (new_local), don't destroy it as a delete."""
    pid = project["id"]
    r = _compare(
        app_client, pid,
        [{"path": "Assets/orphan.fbx", "checksum": _md5(b"new content"), "size_bytes": 11,
          "base_version": 3, "base_checksum": _md5(b"old content")}],
        member["headers"],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["new_local"] == 1
    assert body["summary"]["deleted_remote"] == 0


def test_compare_path_traversal_rejected(app_client, member, project):
    pid = project["id"]
    r = _compare(
        app_client, pid,
        [{"path": "../etc/passwd", "checksum": "x", "size_bytes": 0,
          "base_version": 0, "base_checksum": ""}],
        member["headers"],
    )
    assert r.status_code == 400
