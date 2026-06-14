"""Unit tests for server/storage.py — direct DB calls, no HTTP layer."""

import sqlite3
import secrets
import pytest
import server.storage as storage


# ── Projects ─────────────────────────────────────────────────────────────────

def test_create_and_get_project(tmp_db):
    p = storage.create_project("MyGame", "desc", "#E04E0E", "/tmp/game")
    assert p["id"] > 0
    assert p["name"] == "MyGame"
    fetched = storage.get_project(p["id"])
    assert fetched["name"] == "MyGame"
    assert fetched["description"] == "desc"


def test_list_projects_includes_file_count(tmp_db):
    p = storage.create_project("P", "", "#fff", "")
    m = storage.create_member("user")
    storage.create_file(p["id"], "foo.txt", 10, "aaa")
    storage.create_file(p["id"], "bar.txt", 20, "bbb")
    projects = storage.list_projects()
    row = next(x for x in projects if x["id"] == p["id"])
    assert row["file_count"] == 2


def test_update_project(tmp_db):
    p = storage.create_project("old", "", "#E04E0E", "")
    updated = storage.update_project(p["id"], name="new", color="#000")
    assert updated["name"] == "new"
    assert updated["color"] == "#000"


def test_delete_project(tmp_db):
    p = storage.create_project("del", "", "#E04E0E", "")
    assert storage.delete_project(p["id"]) is True
    assert storage.get_project(p["id"]) is None
    assert storage.delete_project(p["id"]) is False


# ── Members ──────────────────────────────────────────────────────────────────

def test_create_member_stores_hash_not_plaintext(tmp_db):
    result = storage.create_member("alice")
    plaintext_key = result["api_key"]
    # The returned dict has the plaintext
    assert len(plaintext_key) == 32

    # Fetch from DB directly to confirm only hash is stored
    conn = sqlite3.connect(tmp_db)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT api_key FROM members WHERE name = 'alice'").fetchone()
    conn.close()
    stored = row["api_key"]
    assert stored == storage.hash_api_key(plaintext_key)
    assert stored != plaintext_key


def test_get_member_by_name_excludes_key_by_default(tmp_db):
    storage.create_member("bob")
    m = storage.get_member_by_name("bob")
    assert "api_key" not in m


def test_get_member_by_name_includes_key_when_requested(tmp_db):
    storage.create_member("carol")
    m = storage.get_member_by_name("carol", include_key=True)
    assert "api_key" in m
    assert len(m["api_key"]) == 64  # hex SHA-256


def test_reset_member_key_invalidates_old_key(tmp_db):
    result = storage.create_member("dave")
    old_key = result["api_key"]
    new_result = storage.reset_member_key(result["id"])
    new_key = new_result["api_key"]

    assert old_key != new_key
    stored = storage.get_member_by_name("dave", include_key=True)["api_key"]
    # Old key's hash no longer matches stored hash
    import secrets as _s
    assert not _s.compare_digest(storage.hash_api_key(old_key), stored)
    # New key's hash does match
    assert _s.compare_digest(storage.hash_api_key(new_key), stored)


def test_deactivate_member_hides_from_list(tmp_db):
    m = storage.create_member("eve")
    assert any(x["name"] == "eve" for x in storage.list_members())
    storage.deactivate_member(m["id"])
    assert not any(x["name"] == "eve" for x in storage.list_members())


# ── Locking ──────────────────────────────────────────────────────────────────

def _make_locked_file(tmp_db):
    """Helper: project + two members + one file."""
    p = storage.create_project("P", "", "#E04E0E", "")
    m1 = storage.create_member("m1")
    m2 = storage.create_member("m2")
    f = storage.create_file(p["id"], "a.txt", 0, "")
    return p["id"], m1["id"], m2["id"], f["id"]


def test_try_acquire_lock_succeeds_on_unlocked_file(tmp_db):
    _, m1, _, fid = _make_locked_file(tmp_db)
    row = storage.try_acquire_lock(fid, m1)
    assert row["locked_by_id"] == m1


def test_try_acquire_lock_idempotent_for_same_member(tmp_db):
    _, m1, _, fid = _make_locked_file(tmp_db)
    storage.try_acquire_lock(fid, m1, reason="first")
    row = storage.try_acquire_lock(fid, m1, reason="again")
    assert row["locked_by_id"] == m1


def test_try_acquire_lock_blocked_by_foreign_member(tmp_db):
    _, m1, m2, fid = _make_locked_file(tmp_db)
    storage.try_acquire_lock(fid, m1)
    row = storage.try_acquire_lock(fid, m2)
    # Returns current row (still held by m1) — caller checks locked_by_id
    assert row["locked_by_id"] == m1


def test_try_release_lock_by_owner(tmp_db):
    _, m1, _, fid = _make_locked_file(tmp_db)
    storage.try_acquire_lock(fid, m1)
    row, released = storage.try_release_lock(fid, m1)
    assert released is True
    assert row["locked_by_id"] is None


def test_try_release_lock_by_non_owner_returns_false(tmp_db):
    _, m1, m2, fid = _make_locked_file(tmp_db)
    storage.try_acquire_lock(fid, m1)
    row, released = storage.try_release_lock(fid, m2)
    assert released is False
    assert row["locked_by_id"] == m1


# ── commit_new_version ───────────────────────────────────────────────────────

def _fresh_file(tmp_db):
    p = storage.create_project("P", "", "#E04E0E", "")
    m = storage.create_member("author")
    f = storage.create_file(p["id"], "data.bin", 0, "")
    return p["id"], m["id"], f["id"]


def test_commit_new_version_success(tmp_db):
    pid, mid, fid = _fresh_file(tmp_db)
    result = storage.commit_new_version(
        file_id=fid, expected_current_version=1, new_version=1,
        size_bytes=5, checksum="abc123", author_id=mid,
        message="v1", storage_filename="1_v1_data.bin", locker_member_id=None,
    )
    assert result is not None
    assert result["current_version"] == 1
    assert result["checksum"] == "abc123"


def test_commit_new_version_stale_base_returns_none(tmp_db):
    pid, mid, fid = _fresh_file(tmp_db)
    # Commit v1 successfully
    storage.commit_new_version(
        file_id=fid, expected_current_version=1, new_version=1,
        size_bytes=1, checksum="aaa", author_id=mid,
        message="v1", storage_filename="f_v1_d.bin", locker_member_id=None,
    )
    # Try to commit v2 with stale expected version (still 1 instead of current=1→now commit again)
    # Actually after v1, current_version=1; a second commit expects current_version=1 but
    # uses new_version=2. Let's set expected to 0 (wrong).
    result = storage.commit_new_version(
        file_id=fid, expected_current_version=0, new_version=2,
        size_bytes=2, checksum="bbb", author_id=mid,
        message="v2", storage_filename="f_v2_d.bin", locker_member_id=None,
    )
    assert result is None


def test_commit_new_version_foreign_lock_returns_none(tmp_db):
    p = storage.create_project("P", "", "#E04E0E", "")
    m1 = storage.create_member("m1")
    m2 = storage.create_member("m2")
    f = storage.create_file(p["id"], "x.bin", 0, "")
    # m2 holds the lock
    storage.try_acquire_lock(f["id"], m2["id"])
    result = storage.commit_new_version(
        file_id=f["id"], expected_current_version=1, new_version=1,
        size_bytes=1, checksum="x", author_id=m1["id"],
        message="", storage_filename="x_v1.bin", locker_member_id=m1["id"],
    )
    assert result is None


# ── Upload sessions ──────────────────────────────────────────────────────────

def test_upload_session_lifecycle(tmp_db):
    p = storage.create_project("P", "", "#E04E0E", "")
    m = storage.create_member("up")
    uid = "abcdef1234567890abcdef1234567890"
    sess = storage.create_upload_session(uid, p["id"], m["id"], "a.bin", 1000, 0, False, "msg")
    assert sess["id"] == uid
    assert sess["received"] == 0

    storage.set_upload_received(uid, 500)
    fetched = storage.get_upload_session(uid)
    assert fetched["received"] == 500

    assert storage.delete_upload_session(uid) is True
    assert storage.get_upload_session(uid) is None


# ── get_expired_locks ────────────────────────────────────────────────────────

def test_get_expired_locks_threshold(tmp_db):
    p = storage.create_project("P", "", "#E04E0E", "")
    m = storage.create_member("locker")
    f = storage.create_file(p["id"], "l.bin", 0, "")
    storage.try_acquire_lock(f["id"], m["id"])

    # Backdate locked_at to 3 hours ago
    conn = sqlite3.connect(tmp_db)
    conn.execute(
        "UPDATE files SET locked_at = datetime('now', '-3 hours') WHERE id = ?",
        (f["id"],),
    )
    conn.commit()
    conn.close()

    # 2-hour threshold: should find it (locked 3h ago > 2h threshold)
    expired = storage.get_expired_locks(2)
    assert any(e["id"] == f["id"] for e in expired)

    # 4-hour threshold: should NOT find it (3h ago is not older than 4h)
    not_expired = storage.get_expired_locks(4)
    assert not any(e["id"] == f["id"] for e in not_expired)
