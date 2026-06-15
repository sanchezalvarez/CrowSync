"""Raw SQL database operations for CrowSync. No ORM — sqlite3 only."""

import hashlib
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime, timezone

_db_path: str | None = None
_write_lock = threading.Lock()


@contextmanager
def with_transaction():
    """Acquire the write-lock + open a fresh connection inside an IMMEDIATE transaction.
    Use for read-modify-write sequences (e.g. lock check + flip) that must be atomic
    across concurrent requests."""
    with _write_lock:
        conn = _get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def init_db(db_path: str) -> None:
    global _db_path
    _db_path = db_path
    schema_path = Path(__file__).parent / "schema.sql"
    conn = _get_conn()
    conn.executescript(schema_path.read_text())
    # Migrate: add api_key column if missing
    cols = [row[1] for row in conn.execute("PRAGMA table_info(members)").fetchall()]
    if "api_key" not in cols:
        conn.execute("ALTER TABLE members ADD COLUMN api_key TEXT DEFAULT ''")
        conn.commit()
    # Migrate: hash any legacy plaintext keys in place (S2). Plaintext keys are 32
    # hex chars (token_hex(16)); hashes are 64. Hashing the stored plaintext keeps
    # existing clients working — their stored key now hashes to the new column value.
    legacy = conn.execute(
        "SELECT id, api_key FROM members WHERE length(api_key) = 32"
    ).fetchall()
    for row in legacy:
        conn.execute(
            "UPDATE members SET api_key = ? WHERE id = ?",
            (hash_api_key(row["api_key"]), row["id"]),
        )
    if legacy:
        conn.commit()
    # Migrate: lock metadata columns (Unity-aware locking).
    fcols = [row[1] for row in conn.execute("PRAGMA table_info(files)").fetchall()]
    if "lock_reason" not in fcols:
        conn.execute("ALTER TABLE files ADD COLUMN lock_reason TEXT DEFAULT ''")
    if "lock_group_id" not in fcols:
        conn.execute("ALTER TABLE files ADD COLUMN lock_group_id TEXT DEFAULT NULL")
    conn.commit()
    conn.close()


def generate_api_key() -> str:
    """Generate a random 32-char hex API key (the plaintext handed to the client once)."""
    return secrets.token_hex(16)


def hash_api_key(key: str) -> str:
    """SHA-256 (64-char hex) of an API key. Only the hash is stored in the DB (S2);
    auth hashes the incoming key and compares digests, so a DB leak can't reveal keys."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _utc_now_sql() -> str:
    """UTC timestamp in SQLite's `datetime('now')` format (space separator, no
    timezone). Stored timestamps must use this format so string comparisons in
    `get_expired_locks` against `datetime('now', '-Xh')` are well-ordered (V1)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return dict(row)


def _rows_to_list(rows: list[sqlite3.Row]) -> list[dict]:
    return [dict(r) for r in rows]


# ── Projects ─────────────────────────────────────────────────────────

def create_project(name: str, description: str, color: str, root_path: str) -> dict:
    with _write_lock:
        conn = _get_conn()
        cur = conn.execute(
            "INSERT INTO projects (name, description, color, root_path) VALUES (?, ?, ?, ?)",
            (name, description, color, root_path),
        )
        project_id = cur.lastrowid
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        conn.close()
        return _row_to_dict(row)


def get_project(project_id: int) -> dict | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def update_project(project_id: int, **fields) -> dict:
    allowed = {"name", "description", "color", "root_path"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return get_project(project_id)
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [project_id]
    with _write_lock:
        conn = _get_conn()
        conn.execute(f"UPDATE projects SET {set_clause} WHERE id = ?", values)
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        conn.close()
        return _row_to_dict(row)


def list_projects() -> list[dict]:
    conn = _get_conn()
    rows = conn.execute("""
        SELECT p.*, COUNT(f.id) AS file_count
        FROM projects p
        LEFT JOIN files f ON f.project_id = p.id
        GROUP BY p.id
        ORDER BY p.created_at DESC
    """).fetchall()
    conn.close()
    return _rows_to_list(rows)


def delete_project(project_id: int) -> bool:
    with _write_lock:
        conn = _get_conn()
        cur = conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        conn.commit()
        deleted = cur.rowcount > 0
        conn.close()
        return deleted


# ── Members ──────────────────────────────────────────────────────────

def create_member(name: str, email: str = "", avatar_color: str = "#0B7268") -> dict:
    """Create a member. Stores only the hash of the API key; the returned dict carries
    the *plaintext* key under `api_key` so the endpoint can hand it to the client once."""
    api_key = generate_api_key()
    with _write_lock:
        conn = _get_conn()
        cur = conn.execute(
            "INSERT INTO members (name, email, avatar_color, api_key) VALUES (?, ?, ?, ?)",
            (name, email, avatar_color, hash_api_key(api_key)),
        )
        member_id = cur.lastrowid
        conn.commit()
        row = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
        conn.close()
        result = _row_to_dict(row)
        result["api_key"] = api_key  # plaintext, one-time return
        return result


def reset_member_key(member_id: int) -> dict:
    """Regenerate a member's API key (recovery on a new machine). Since we only store
    the hash, the original can't be recovered — this issues a fresh key and the dict
    carries the plaintext. Any old machine's key stops working."""
    api_key = generate_api_key()
    with _write_lock:
        conn = _get_conn()
        conn.execute(
            "UPDATE members SET api_key = ?, is_active = 1 WHERE id = ?",
            (hash_api_key(api_key), member_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
        conn.close()
        result = _row_to_dict(row)
        result["api_key"] = api_key
        return result


def get_member_by_name(name: str, include_key: bool = False) -> dict | None:
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM members WHERE name = ? AND is_active = 1", (name,)
    ).fetchone()
    conn.close()
    result = _row_to_dict(row)
    if result and not include_key:
        result.pop("api_key", None)
    return result


def get_member(member_id: int) -> dict | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def list_members() -> list[dict]:
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, name, email, avatar_color, is_active, created_at FROM members WHERE is_active = 1 ORDER BY name"
    ).fetchall()
    conn.close()
    return _rows_to_list(rows)


def deactivate_member(member_id: int) -> bool:
    with _write_lock:
        conn = _get_conn()
        cur = conn.execute("UPDATE members SET is_active = 0 WHERE id = ?", (member_id,))
        conn.commit()
        updated = cur.rowcount > 0
        conn.close()
        return updated


# ── Files ────────────────────────────────────────────────────────────

def create_file(project_id: int, path: str, size_bytes: int, checksum: str) -> dict:
    with _write_lock:
        conn = _get_conn()
        cur = conn.execute(
            "INSERT INTO files (project_id, path, size_bytes, checksum) VALUES (?, ?, ?, ?)",
            (project_id, path, size_bytes, checksum),
        )
        file_id = cur.lastrowid
        conn.commit()
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        conn.close()
        return _row_to_dict(row)


def get_file(file_id: int) -> dict | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def get_file_by_path(project_id: int, path: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM files WHERE project_id = ? AND path = ?", (project_id, path)
    ).fetchone()
    conn.close()
    return _row_to_dict(row)


def list_files(project_id: int) -> list[dict]:
    conn = _get_conn()
    rows = conn.execute("""
        SELECT f.*, m.name AS locked_by_name, m.avatar_color AS locked_by_color
        FROM files f
        LEFT JOIN members m ON f.locked_by_id = m.id
        WHERE f.project_id = ?
        ORDER BY f.path
    """, (project_id,)).fetchall()
    conn.close()
    return _rows_to_list(rows)


def update_file(file_id: int, **fields) -> dict:
    allowed = {"current_version", "size_bytes", "checksum", "locked_by_id", "locked_at",
               "lock_reason", "lock_group_id", "last_synced_at"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return get_file(file_id)
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [file_id]
    with _write_lock:
        conn = _get_conn()
        conn.execute(f"UPDATE files SET {set_clause} WHERE id = ?", values)
        conn.commit()
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        conn.close()
        return _row_to_dict(row)


def unlock_file(file_id: int) -> dict:
    return update_file(file_id, locked_by_id=None, locked_at=None, lock_reason="", lock_group_id=None)


def try_acquire_lock(
    file_id: int, member_id: int, reason: str = "", group_id: str | None = None,
) -> dict | None:
    """Atomically: acquire lock if file is unlocked or already held by member_id.
    Stores who/when plus an optional reason and lock-group id (files locked together
    share a group_id). Returns updated row on success, None if locked by someone else."""
    now = _utc_now_sql()  # SQLite-comparable format so auto-unlock (V1) works
    with with_transaction() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            return None
        current = row["locked_by_id"]
        if current is not None and current != member_id:
            return _row_to_dict(row)  # caller checks locked_by_id mismatch
        conn.execute(
            "UPDATE files SET locked_by_id = ?, locked_at = ?, lock_reason = ?, lock_group_id = ? WHERE id = ?",
            (member_id, now, reason or "", group_id, file_id),
        )
        updated = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        return _row_to_dict(updated)


def try_release_lock(file_id: int, member_id: int) -> tuple[dict | None, bool]:
    """Atomically: release lock if held by member_id. Returns (row, released_bool).
    released_bool=False if file is held by someone else."""
    with with_transaction() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            return None, False
        current = row["locked_by_id"]
        if current is not None and current != member_id:
            return _row_to_dict(row), False
        conn.execute(
            "UPDATE files SET locked_by_id = NULL, locked_at = NULL, lock_reason = '', lock_group_id = NULL WHERE id = ?",
            (file_id,),
        )
        updated = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        return _row_to_dict(updated), True


def commit_new_version(
    file_id: int, expected_current_version: int, new_version: int,
    size_bytes: int, checksum: str, author_id: int, message: str,
    storage_filename: str, locker_member_id: int | None,
) -> dict | None:
    """Atomically: assert no foreign lock + assert file.current_version == expected,
    insert versions row, bump files.current_version. Returns new file row or None on conflict.
    `locker_member_id` is the caller's member id; if file is locked by someone else, abort."""
    now = datetime.now(timezone.utc).isoformat()
    with with_transaction() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            return None
        if row["current_version"] != expected_current_version:
            return None
        if row["locked_by_id"] is not None and row["locked_by_id"] != locker_member_id:
            return None
        conn.execute(
            """INSERT INTO versions (file_id, version, size_bytes, checksum, author_id, message, storage_filename)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (file_id, new_version, size_bytes, checksum, author_id, message, storage_filename),
        )
        conn.execute(
            "UPDATE files SET current_version = ?, size_bytes = ?, checksum = ?, last_synced_at = ? WHERE id = ?",
            (new_version, size_bytes, checksum, now, file_id),
        )
        updated = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        return _row_to_dict(updated)


def delete_file(file_id: int) -> bool:
    with _write_lock:
        conn = _get_conn()
        cur = conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
        conn.commit()
        deleted = cur.rowcount > 0
        conn.close()
        return deleted


def get_expired_locks(hours: int) -> list[dict]:
    conn = _get_conn()
    rows = conn.execute("""
        SELECT f.id, f.path, f.project_id, m.name AS locked_by_name
        FROM files f
        JOIN members m ON f.locked_by_id = m.id
        WHERE f.locked_by_id IS NOT NULL
          AND f.locked_at < datetime('now', ? || ' hours')
    """, (f"-{hours}",)).fetchall()
    conn.close()
    return _rows_to_list(rows)


# ── Resumable upload sessions ────────────────────────────────────────

def create_upload_session(
    upload_id: str, project_id: int, member_id: int, file_path: str,
    total_size: int, base_version: int, force: bool, message: str,
) -> dict:
    now = _utc_now_sql()
    with _write_lock:
        conn = _get_conn()
        conn.execute(
            """INSERT INTO upload_sessions
                 (id, project_id, member_id, file_path, total_size, received,
                  base_version, force, message, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)""",
            (upload_id, project_id, member_id, file_path, total_size,
             base_version, 1 if force else 0, message, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM upload_sessions WHERE id = ?", (upload_id,)).fetchone()
        conn.close()
        return _row_to_dict(row)


def get_upload_session(upload_id: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM upload_sessions WHERE id = ?", (upload_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def set_upload_received(upload_id: str, received: int) -> None:
    """Record progress for a session (advisory — the authoritative offset is the
    partial blob's on-disk size). Also bumps updated_at so GC sees recent activity."""
    now = _utc_now_sql()
    with _write_lock:
        conn = _get_conn()
        conn.execute(
            "UPDATE upload_sessions SET received = ?, updated_at = ? WHERE id = ?",
            (received, now, upload_id),
        )
        conn.commit()
        conn.close()


def delete_upload_session(upload_id: str) -> bool:
    with _write_lock:
        conn = _get_conn()
        cur = conn.execute("DELETE FROM upload_sessions WHERE id = ?", (upload_id,))
        conn.commit()
        deleted = cur.rowcount > 0
        conn.close()
        return deleted


def get_stale_upload_sessions(hours: int) -> list[dict]:
    """Sessions not touched within `hours` — abandoned transfers to GC."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM upload_sessions WHERE updated_at < datetime('now', ? || ' hours')",
        (f"-{hours}",),
    ).fetchall()
    conn.close()
    return _rows_to_list(rows)


# ── Versions ─────────────────────────────────────────────────────────
# Version rows are inserted atomically inside commit_new_version (with the
# files.current_version bump under one transaction); there's no standalone insert.

def get_version(file_id: int, version: int) -> dict | None:
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM versions WHERE file_id = ? AND version = ?", (file_id, version)
    ).fetchone()
    conn.close()
    return _row_to_dict(row)


def get_latest_version(file_id: int) -> dict | None:
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM versions WHERE file_id = ? ORDER BY version DESC LIMIT 1", (file_id,)
    ).fetchone()
    conn.close()
    return _row_to_dict(row)


def list_versions(file_id: int) -> list[dict]:
    conn = _get_conn()
    rows = conn.execute("""
        SELECT v.*, m.name AS author_name
        FROM versions v
        LEFT JOIN members m ON v.author_id = m.id
        WHERE v.file_id = ?
        ORDER BY v.version DESC
    """, (file_id,)).fetchall()
    conn.close()
    return _rows_to_list(rows)


# ── Activity ─────────────────────────────────────────────────────────

def create_activity(
    project_id: int, member_id: int | None, file_id: int | None,
    action: str, file_path: str = "", version: int | None = None, detail: str = "",
) -> dict:
    with _write_lock:
        conn = _get_conn()
        cur = conn.execute(
            """INSERT INTO activity (project_id, member_id, file_id, action, file_path, version, detail)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (project_id, member_id, file_id, action, file_path, version, detail),
        )
        activity_id = cur.lastrowid
        conn.commit()
        row = conn.execute("SELECT * FROM activity WHERE id = ?", (activity_id,)).fetchone()
        conn.close()
        return _row_to_dict(row)


def create_pull_session(project_id: int, member_id: int, files: list[dict]) -> int:
    """files: list of {path, pre_version, new_version}"""
    with with_transaction() as conn:
        cur = conn.execute(
            "INSERT INTO pull_sessions (project_id, member_id, file_count) VALUES (?, ?, ?)",
            (project_id, member_id, len(files)),
        )
        session_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO pull_session_files (session_id, file_path, pre_version, new_version) VALUES (?, ?, ?, ?)",
            [(session_id, f["path"], f["pre_version"], f["new_version"]) for f in files],
        )
        return session_id


def list_pull_sessions(project_id: int, limit: int = 20) -> list[dict]:
    conn = _get_conn()
    rows = conn.execute(
        """SELECT ps.id, ps.project_id, ps.member_id, ps.file_count, ps.created_at,
                  m.name AS member_name, m.avatar_color
           FROM pull_sessions ps
           LEFT JOIN members m ON ps.member_id = m.id
           WHERE ps.project_id = ?
           ORDER BY ps.created_at DESC LIMIT ?""",
        (project_id, limit),
    ).fetchall()
    sessions = [dict(r) for r in rows]
    ids = [s["id"] for s in sessions]
    # Fetch every session's files in one query (IN-list) instead of one query
    # per session, then group in Python — avoids the N+1 round-trips.
    files_by_session: dict[int, list[dict]] = {sid: [] for sid in ids}
    if ids:
        placeholders = ",".join("?" * len(ids))
        file_rows = conn.execute(
            f"""SELECT session_id, file_path, pre_version, new_version
                FROM pull_session_files WHERE session_id IN ({placeholders}) ORDER BY id""",
            ids,
        ).fetchall()
        for fr in file_rows:
            fd = dict(fr)
            files_by_session[fd.pop("session_id")].append(fd)
    for s in sessions:
        s["files"] = files_by_session[s["id"]]
    conn.close()
    return sessions


def get_pull_session(session_id: int) -> dict | None:
    conn = _get_conn()
    row = conn.execute(
        """SELECT ps.id, ps.project_id, ps.member_id, ps.file_count, ps.created_at,
                  m.name AS member_name
           FROM pull_sessions ps
           LEFT JOIN members m ON ps.member_id = m.id
           WHERE ps.id = ?""",
        (session_id,),
    ).fetchone()
    if not row:
        conn.close()
        return None
    files = conn.execute(
        "SELECT file_path, pre_version, new_version FROM pull_session_files WHERE session_id = ? ORDER BY id",
        (session_id,),
    ).fetchall()
    d = dict(row)
    d["files"] = [dict(f) for f in files]
    conn.close()
    return d


def list_activity(project_id: int, limit: int = 50, offset: int = 0) -> list[dict]:
    conn = _get_conn()
    rows = conn.execute("""
        SELECT a.*, m.name AS member_name, m.avatar_color AS member_color
        FROM activity a
        LEFT JOIN members m ON a.member_id = m.id
        WHERE a.project_id = ?
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?
    """, (project_id, limit, offset)).fetchall()
    conn.close()
    return _rows_to_list(rows)


# ── Settings ─────────────────────────────────────────────────────────

def get_setting(key: str, default: str = "") -> str:
    conn = _get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    if row is None:
        return default
    return row["value"]


def set_setting(key: str, value: str) -> None:
    with _write_lock:
        conn = _get_conn()
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value)
        )
        conn.commit()
        conn.close()
