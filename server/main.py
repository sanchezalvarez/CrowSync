"""CrowSync FastAPI server — file versioning & locking for game dev teams."""

import asyncio
import json
import logging
import os
import secrets
import shutil
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import (
    Depends, FastAPI, Header, HTTPException, Query, Request, UploadFile,
    WebSocket, WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from server import storage, file_manager, unity
from server.websocket_manager import WebSocketManager

load_dotenv()

logging.basicConfig(level=os.getenv("CROWSYNC_LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("crowsync")

DB_PATH = os.getenv("CROWSYNC_DB_PATH", "./crowsync.db")
STORAGE_ROOT = os.getenv("CROWSYNC_STORAGE_ROOT", "./storage")
PORT = int(os.getenv("CROWSYNC_PORT", "8001"))
ADMIN_TOKEN = os.getenv("CROWSYNC_ADMIN_TOKEN", "")
# Trusted-LAN mode: when enabled, anyone reachable on the network may self-register
# (or re-register to recover a lost key) with just a name — no admin token. Intended
# for a local game-dev team behind a firewall, NOT for an internet-exposed server.
OPEN_REGISTRATION = os.getenv("CROWSYNC_OPEN_REGISTRATION", "").strip().lower() in ("1", "true", "yes", "on")

ws_manager = WebSocketManager()


def get_storage_root() -> str:
    """Get storage root from DB settings, fallback to env var."""
    return storage.get_setting("storage_root", STORAGE_ROOT)


def normalize_rel_path(rel_path: str) -> str:
    """Validate and normalize a relative path coming from query/body.
    Returns canonical form with forward slashes. Raises 400 on traversal."""
    if not rel_path:
        raise HTTPException(400, "Path required")
    p = rel_path.replace("\\", "/")
    if p.startswith("/") or ":" in p[:3]:
        raise HTTPException(400, "Invalid path")
    parts = [seg for seg in p.split("/") if seg not in ("", ".")]
    if any(seg == ".." for seg in parts):
        raise HTTPException(400, "Path escapes project root")
    return "/".join(parts)


# ── Lifespan ─────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.init_db(DB_PATH)
    Path(STORAGE_ROOT).mkdir(parents=True, exist_ok=True)
    # Also create user-configured storage dir if set
    configured = storage.get_setting("storage_root", "")
    if configured and configured != STORAGE_ROOT:
        Path(configured).mkdir(parents=True, exist_ok=True)
    task = asyncio.create_task(_auto_unlock_loop())
    yield
    task.cancel()


app = FastAPI(title="CrowSync", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:1420", "tauri://localhost", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Member identification ────────────────────────────────────────────

async def get_current_member(
    x_member_name: str = Header(...),
    x_api_key: str = Header(""),
):
    """Authenticate member by name + API key."""
    name = x_member_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="X-Member-Name header required")

    member = storage.get_member_by_name(name, include_key=True)
    if not member:
        raise HTTPException(status_code=401, detail="Unknown member. Register via POST /members first.")

    expected_hash = member.get("api_key", "") or ""
    if not x_api_key or not secrets.compare_digest(storage.hash_api_key(x_api_key), expected_hash):
        raise HTTPException(status_code=401, detail="Invalid or missing API key")

    # Strip api_key from result
    return {k: v for k, v in member.items() if k != "api_key"}


async def require_admin_or_bootstrap(
    x_admin_token: str = Header(""),
):
    """Allow if (a) no members exist yet (bootstrap), or
    (b) X-Admin-Token matches CROWSYNC_ADMIN_TOKEN env var."""
    members = storage.list_members()
    if not members:
        return  # bootstrap mode — first member self-registers
    if OPEN_REGISTRATION:
        return  # trusted-LAN mode — anyone may register / recover a key without a token
    if not ADMIN_TOKEN:
        raise HTTPException(
            403,
            "Member registration disabled: set CROWSYNC_ADMIN_TOKEN in server env to enable.",
        )
    if not x_admin_token or not secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(403, "Invalid or missing X-Admin-Token")


async def require_admin(x_admin_token: str = Header("")):
    """Strict admin gate (no bootstrap) for destructive operations (S1): deleting a
    project or member, or changing server settings. Always requires a valid token."""
    if not ADMIN_TOKEN:
        raise HTTPException(403, "Admin operations disabled: set CROWSYNC_ADMIN_TOKEN in server env.")
    if not x_admin_token or not secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(403, "Invalid or missing X-Admin-Token")


# ── Rate limiting ────────────────────────────────────────────────────
# In-memory sliding window for POST /members — the only unauthenticated-ish
# surface (admin-token guessing). Per-process; fine for a single-instance server.
_MEMBERS_RATE_MAX = 10        # attempts
_MEMBERS_RATE_WINDOW = 60.0   # seconds
_members_hits: dict[str, list[float]] = defaultdict(list)


def _rate_limit_members(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    hits = _members_hits[ip]
    cutoff = now - _MEMBERS_RATE_WINDOW
    hits[:] = [t for t in hits if t > cutoff]
    if len(hits) >= _MEMBERS_RATE_MAX:
        raise HTTPException(429, detail="Too many registration attempts. Try again later.")
    hits.append(now)


# WebSocket auth uses the same sliding-window shape so api-key guessing over the WS
# handshake is throttled like POST /members (M3). Separate bucket, looser cap.
_WS_RATE_MAX = 20
_WS_RATE_WINDOW = 60.0
_ws_auth_hits: dict[str, list[float]] = defaultdict(list)


def _rate_limit_ws(ip: str) -> bool:
    """Record a WS auth attempt; return False if the IP is over the limit."""
    now = time.monotonic()
    hits = _ws_auth_hits[ip]
    cutoff = now - _WS_RATE_WINDOW
    hits[:] = [t for t in hits if t > cutoff]
    if len(hits) >= _WS_RATE_MAX:
        return False
    hits.append(now)
    return True


def _gc_rate_limit_buckets() -> None:
    """Drop per-IP buckets with no recent hits so the in-memory maps stay bounded
    over a long-running process (M2). Called from the hourly auto-unlock loop."""
    now = time.monotonic()
    for bucket, window in ((_members_hits, _MEMBERS_RATE_WINDOW), (_ws_auth_hits, _WS_RATE_WINDOW)):
        cutoff = now - window
        for ip in [ip for ip, hits in bucket.items() if not any(t > cutoff for t in hits)]:
            del bucket[ip]


# ── Request models ───────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    color: str = "#E04E0E"

class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    color: str | None = None

class MemberCreate(BaseModel):
    name: str
    email: str = ""
    avatar_color: str = "#0B7268"

class FileLockRequest(BaseModel):
    path: str
    reason: str = ""
    # Extra paths to lock together with `path` under one lock-group (the client's
    # picks from the dependency dialog). The asset's own .meta is auto-added server-side.
    also: list[str] = []
    # Unlock only this file or the whole lock-group it belongs to. Ignored by lock.
    scope: str = "file"  # "file" | "group"

class FileRevertRequest(BaseModel):
    path: str
    version: int

class PathRequest(BaseModel):
    path: str

class ManifestEntry(BaseModel):
    path: str
    checksum: str
    size_bytes: int = 0
    # Client's sync base (last version+checksum it successfully synced for this
    # path). 0 / "" means never synced. Lets compare attribute a checksum mismatch
    # to "I changed it" vs "server has newer" vs "both" — see compare_project (K1).
    base_version: int = 0
    base_checksum: str = ""

class Tombstone(BaseModel):
    """A path the client has a sync base for but is no longer on its disk (locally
    deleted). Lets compare distinguish "I deleted it" from "I never had it" so the
    delete can propagate to the server instead of the file resurrecting (D1)."""
    path: str
    base_version: int = 0
    base_checksum: str = ""

class CompareManifest(BaseModel):
    """Client-supplied snapshot of the member's local working folder.
    Replaces the old server-side scan of project.root_path."""
    files: list[ManifestEntry] = []
    tombstones: list[Tombstone] = []


# ── Health ───────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    projects = storage.list_projects()
    members = storage.list_members()
    return {
        "status": "ok",
        "version": storage.get_setting("server_version", "0.1.0"),
        "projects": len(projects),
        "members": len(members),
        # Lets the setup UI hide the admin-token field and just ask for a name.
        "open_registration": OPEN_REGISTRATION or not members,
    }


# ── Projects ─────────────────────────────────────────────────────────

@app.get("/projects")
async def list_projects(member: dict = Depends(get_current_member)):
    return storage.list_projects()


@app.post("/projects", status_code=201)
async def create_project(body: ProjectCreate, member: dict = Depends(get_current_member)):
    # root_path is a legacy column (the local working folder is client-side now) — pass
    # empty; the server no longer reads it for sync (N4).
    project = storage.create_project(body.name, body.description, body.color, "")
    file_manager.get_storage_dir(get_storage_root(), project["id"])
    return project


@app.put("/projects/{project_id}")
async def update_project(project_id: int, body: ProjectUpdate, member: dict = Depends(get_current_member)):
    project = storage.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        return project
    updated = storage.update_project(project_id, **updates)
    return updated


@app.get("/projects/{project_id}")
async def get_project(project_id: int, member: dict = Depends(get_current_member)):
    project = storage.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    files = storage.list_files(project_id)
    return {**project, "file_count": len(files), "files": files}


@app.get("/ignore-patterns")
async def get_ignore_patterns(member: dict = Depends(get_current_member)):
    """Single source of truth for default ignore rules. The client mirrors these
    into its native scan so server and client agree on what to skip."""
    return {"patterns": file_manager.DEFAULT_IGNORE_PATTERNS}


@app.get("/unity-ignore-patterns")
async def get_unity_ignore_patterns(member: dict = Depends(get_current_member)):
    """Extra ignore rules applied only when the client detects a Unity project
    (Assets/ + ProjectSettings/ locally). The client merges these into its scan and
    the settings panel lists them. See unity.UNITY_IGNORE_PATTERNS."""
    return {"patterns": unity.UNITY_IGNORE_PATTERNS}


@app.post("/projects/{project_id}/compare")
async def compare_project(
    project_id: int,
    manifest: CompareManifest,
    member: dict = Depends(get_current_member),
):
    """Diff a client-supplied manifest of the member's local working folder against
    server-tracked files. The client scans its own disk (Tauri) and posts the manifest
    (including each file's sync base); the server never reads the member's filesystem.

    A checksum mismatch is attributed via the client's sync base (K1):
      - only the local file moved        → modified_local (push)
      - only the server moved            → behind (pull)
      - both moved (or no base recorded) → conflict (manual resolve / force)
    Returns: new_local, modified_local, behind, conflict, new_remote, synced."""
    project = storage.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    # Local snapshot comes from the request body, not a server-side scan.
    local_map = {normalize_rel_path(f.path): {
                 "path": normalize_rel_path(f.path), "size_bytes": f.size_bytes,
                 "checksum": f.checksum, "base_version": f.base_version,
                 "base_checksum": f.base_checksum}
                 for f in manifest.files}

    server_files = storage.list_files(project_id)
    server_map = {f["path"]: f for f in server_files}

    new_local = []        # exists locally, not on server → push candidates
    modified_local = []   # local changed, server unchanged → push candidates
    behind = []           # server changed, local unchanged → pull candidates
    conflict = []         # both changed (or no base) → manual resolve
    new_remote = []       # on server, not locally → pull candidates
    synced = []           # same checksum
    deleted_local = []    # client deleted it, server unchanged → delete on server (push)
    deleted_remote = []   # server deleted it, local unchanged → delete locally (pull)

    for path, local in local_map.items():
        server = server_map.get(path)
        if server is None:
            # Not on the server. With a recorded base + unchanged content this is a
            # file the server deleted (our copy is the leftover) → propagate the delete
            # locally. A changed checksum means the user has new/edited content → re-add
            # as new_local, don't destroy their work (D1).
            if local["base_version"] > 0 and local["checksum"] == local["base_checksum"]:
                deleted_remote.append({"path": path})
            else:
                new_local.append({"path": path, "size_bytes": local["size_bytes"], "checksum": local["checksum"]})
            continue
        if local["checksum"] == server["checksum"]:
            synced.append({"path": path, "version": server["current_version"]})
            continue

        # Checksums differ — attribute the change using the client's sync base.
        entry = {
            "path": path,
            "local_checksum": local["checksum"],
            "local_size": local["size_bytes"],
            "server_checksum": server["checksum"],
            "server_version": server["current_version"],
        }
        has_base = local["base_version"] > 0
        local_changed = local["checksum"] != local["base_checksum"]
        server_changed = server["current_version"] != local["base_version"]
        if not has_base:
            # No recorded base — can't safely say who changed it; force a decision
            # rather than risk silently overwriting a teammate's version (K1).
            conflict.append(entry)
        elif local_changed and server_changed:
            conflict.append(entry)
        elif server_changed:
            behind.append({
                "path": path,
                "server_version": server["current_version"],
                "server_checksum": server["checksum"],
                "size_bytes": server["size_bytes"],
            })
        else:
            modified_local.append(entry)

    # Local deletes: paths the client had a base for but no longer has on disk.
    # If the server still has the file unchanged since that base → propagate the
    # delete to the server (deleted_local). If the server moved meanwhile it's a
    # delete-vs-edit conflict → manual resolve. Already-gone → ignore (D1).
    tombstone_paths = set()
    for t in manifest.tombstones:
        path = normalize_rel_path(t.path)
        tombstone_paths.add(path)
        server = server_map.get(path)
        if server is None:
            continue
        if server["current_version"] == t.base_version:
            deleted_local.append({"path": path})
        else:
            conflict.append({
                "path": path,
                "local_checksum": "",
                "local_size": 0,
                "server_checksum": server["checksum"],
                "server_version": server["current_version"],
            })

    for path, server in server_map.items():
        if path not in local_map and path not in tombstone_paths:
            new_remote.append({
                "path": path,
                "server_version": server["current_version"],
                "server_checksum": server["checksum"],
                "size_bytes": server["size_bytes"],
            })

    # Unity push-safety: detect the project from the local manifest, then warn when
    # an asset/.meta pair would push out of sync. Non-blocking — surfaced in the UI.
    all_paths = set(local_map.keys()) | set(server_map.keys())
    is_unity = unity.is_unity_project(all_paths)
    unity_warnings = []
    if is_unity:
        changed = {f["path"] for f in new_local} | {e["path"] for e in modified_local}
        unity_warnings = unity.validate_unity_push_safety(changed, all_paths)

    return {
        "new_local": new_local,
        "modified_local": modified_local,
        "behind": behind,
        "conflict": conflict,
        "new_remote": new_remote,
        "synced": synced,
        "deleted_local": deleted_local,
        "deleted_remote": deleted_remote,
        "unity": {"is_unity": is_unity, "warnings": unity_warnings},
        "summary": {
            "new_local": len(new_local),
            "modified_local": len(modified_local),
            "behind": len(behind),
            "conflict": len(conflict),
            "new_remote": len(new_remote),
            "synced": len(synced),
            "deleted_local": len(deleted_local),
            "deleted_remote": len(deleted_remote),
            "total_local": len(local_map),
            "total_server": len(server_files),
        }
    }


@app.delete("/projects/{project_id}")
async def delete_project(
    project_id: int,
    member: dict = Depends(get_current_member),
    _admin: None = Depends(require_admin),
):
    project = storage.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    file_manager.delete_project_storage(get_storage_root(), project_id)
    storage.delete_project(project_id)
    return {"ok": True}


# ── Members ──────────────────────────────────────────────────────────

@app.get("/members")
async def list_members(member: dict = Depends(get_current_member)):
    return storage.list_members()


@app.post("/members", status_code=201)
async def create_member(
    body: MemberCreate,
    request: Request,
    _: None = Depends(require_admin_or_bootstrap),
):
    _rate_limit_members(request)
    existing = storage.get_member_by_name(body.name, include_key=True)
    if existing:
        # Recovery on a new machine: we only store the key's hash, so the original
        # can't be returned — issue a fresh key (gated by the admin token via the
        # dependency above). Any previous machine's key stops working.
        return storage.reset_member_key(existing["id"])
    # New member — returns the plaintext api_key for first-time registration.
    return storage.create_member(body.name, body.email, body.avatar_color)


@app.delete("/members/{member_id}")
async def delete_member(
    member_id: int,
    member: dict = Depends(get_current_member),
    _admin: None = Depends(require_admin),
):
    if not storage.deactivate_member(member_id):
        raise HTTPException(404, "Member not found")
    return {"ok": True}


# ── Files ────────────────────────────────────────────────────────────

@app.get("/projects/{project_id}/files")
async def list_files(project_id: int, member: dict = Depends(get_current_member)):
    project = storage.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    files = storage.list_files(project_id)
    result = []
    for f in files:
        entry = dict(f)
        if f["locked_by_id"]:
            entry["locked_by"] = {
                "id": f["locked_by_id"],
                "name": f.get("locked_by_name", ""),
            }
        else:
            entry["locked_by"] = None
        result.append(entry)
    return result


def _assert_upload_allowed(existing: dict | None, member: dict, base_version: int, force: bool) -> None:
    """Lock (423) + stale-base conflict (409) gate shared by the multipart and
    resumable upload paths. `existing` is None for a brand-new file (always allowed).
    The atomic guard still lives in `commit_new_version`; this only fails fast with
    a descriptive error before bytes are streamed."""
    if not existing:
        return
    if existing["locked_by_id"] and existing["locked_by_id"] != member["id"]:
        locker = storage.get_member(existing["locked_by_id"])
        raise HTTPException(423, detail={
            "locked": True,
            "locked_by": locker["name"] if locker else "Unknown",
            "locked_at": existing["locked_at"],
        })
    if base_version > 0 and base_version < existing["current_version"] and not force:
        latest = storage.get_latest_version(existing["id"])
        author = storage.get_member(latest["author_id"]) if latest and latest["author_id"] else None
        raise HTTPException(409, detail={
            "conflict": True,
            "server_version": existing["current_version"],
            "server_author": author["name"] if author else "Unknown",
            "message": latest["message"] if latest else "",
        })


@app.post("/projects/{project_id}/files/upload")
async def upload_file(
    project_id: int,
    file: UploadFile,
    path: str = Query(...),
    message: str = Query(""),
    base_version: int = Query(0),
    force: bool = Query(False),
    member: dict = Depends(get_current_member),
):
    project = storage.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    path = normalize_rel_path(path)
    existing = storage.get_file_by_path(project_id, path)
    _assert_upload_allowed(existing, member, base_version, force)

    if existing:
        new_version = existing["current_version"] + 1
        file_id = existing["id"]
    else:
        # New file
        new_version = 1
        new_file = storage.create_file(project_id, path, 0, "")
        file_id = new_file["id"]

    # Check file size limit (try header first to fail fast before streaming GBs)
    max_size_mb = int(storage.get_setting("max_file_size_mb", "2048"))
    max_size_bytes = max_size_mb * 1024 * 1024
    declared_len = file.headers.get("content-length") if file.headers else None
    if declared_len:
        try:
            if int(declared_len) > max_size_bytes:
                if not existing:
                    storage.delete_file(file_id)
                raise HTTPException(413, detail=f"File too large: {int(declared_len) // (1024*1024)}MB exceeds limit of {max_size_mb}MB")
        except ValueError:
            pass

    # Save file to disk (with hard-cap to abort runaway streams)
    original_name = path.split("/")[-1] if "/" in path else path
    storage_filename = file_manager.make_storage_filename(file_id, new_version, original_name)
    stored_path = file_manager.get_file_path(get_storage_root(), project_id, storage_filename)
    try:
        storage_filename, md5, size = await file_manager.save_file_streaming(
            get_storage_root(), project_id, file_id, new_version, original_name, file,
            max_bytes=max_size_bytes,
        )
    except file_manager.UploadTooLarge as e:
        stored_path.unlink(missing_ok=True)
        if not existing:
            storage.delete_file(file_id)
        raise HTTPException(413, detail=f"File too large: exceeds limit of {max_size_mb}MB ({e})")
    except Exception:
        stored_path.unlink(missing_ok=True)
        if not existing:
            storage.delete_file(file_id)
        raise

    # Atomic version commit (B5): asserts no foreign lock + version still matches.
    # New rows are created with current_version=1 (schema default), so the expected
    # value for the first commit on a brand-new row is 1, not 0.
    try:
        updated = storage.commit_new_version(
            file_id=file_id,
            expected_current_version=(existing["current_version"] if existing else 1),
            new_version=new_version,
            size_bytes=size,
            checksum=md5,
            author_id=member["id"],
            message=message,
            storage_filename=storage_filename,
            locker_member_id=member["id"],
        )
    except Exception:
        stored_path.unlink(missing_ok=True)
        if not existing:
            storage.delete_file(file_id)
        raise

    if updated is None:
        # Race: someone uploaded a newer version or grabbed lock between our check and commit.
        stored_path.unlink(missing_ok=True)
        if not existing:
            storage.delete_file(file_id)
        raise HTTPException(409, detail={
            "conflict": True,
            "message": "Concurrent modification — refresh and retry",
        })

    # Log activity
    storage.create_activity(
        project_id, member["id"], file_id, "upload", path, new_version,
        f"{member['name']} uploaded v{new_version}",
    )

    # Broadcast
    await ws_manager.broadcast(project_id, "uploaded", {
        "path": path, "version": new_version, "member": member["name"],
    }, exclude_member=member["id"])

    return updated


# ── Resumable upload (tus-lite) ──────────────────────────────────────
# The native client (fs_ops.rs:upload_file) uses this 3-step flow so a dropped
# connection resumes from the last received byte instead of restarting a multi-GB
# transfer: init (fail-fast lock/conflict/size check + open a session) → PATCH
# chunks (offset = the partial blob's current size) → complete (md5 + atomic
# commit_new_version). The multipart endpoint above stays for the browser UI.

def _part_size(part_path: Path) -> int:
    return part_path.stat().st_size if part_path.exists() else 0


@app.post("/projects/{project_id}/files/upload/init")
async def upload_init(
    project_id: int,
    path: str = Query(...),
    size: int = Query(..., ge=0),
    message: str = Query(""),
    base_version: int = Query(0),
    force: bool = Query(False),
    upload_id: str = Query(""),
    member: dict = Depends(get_current_member),
):
    project = storage.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    path = normalize_rel_path(path)
    max_size_mb = int(storage.get_setting("max_file_size_mb", "2048"))
    if size > max_size_mb * 1024 * 1024:
        raise HTTPException(413, detail=f"File too large: {size // (1024*1024)}MB exceeds limit of {max_size_mb}MB")

    existing = storage.get_file_by_path(project_id, path)
    _assert_upload_allowed(existing, member, base_version, force)

    # Client may supply its own id (for cross-restart resume — it persists the id
    # before transferring). Validate it's a plain hex token so it's a safe filename.
    if upload_id:
        if not (0 < len(upload_id) <= 64 and all(c in "0123456789abcdef" for c in upload_id)):
            raise HTTPException(400, "Invalid upload_id")
    else:
        upload_id = secrets.token_hex(16)
    file_manager.create_empty_part(get_storage_root(), project_id, upload_id)
    storage.create_upload_session(
        upload_id, project_id, member["id"], path, size, base_version, force, message,
    )
    return {"upload_id": upload_id, "offset": 0, "chunk_size": file_manager.CHUNK_SIZE}


def _get_owned_session(project_id: int, upload_id: str, member: dict) -> dict:
    sess = storage.get_upload_session(upload_id)
    if not sess or sess["project_id"] != project_id:
        raise HTTPException(404, "Upload session not found")
    if sess["member_id"] != member["id"]:
        raise HTTPException(403, "Upload session belongs to another member")
    return sess


@app.get("/projects/{project_id}/files/upload/{upload_id}")
async def upload_status(
    project_id: int,
    upload_id: str,
    member: dict = Depends(get_current_member),
):
    sess = _get_owned_session(project_id, upload_id, member)
    part = file_manager.upload_part_path(get_storage_root(), project_id, upload_id)
    return {"upload_id": upload_id, "offset": _part_size(part), "total_size": sess["total_size"]}


@app.patch("/projects/{project_id}/files/upload/{upload_id}")
async def upload_chunk(
    project_id: int,
    upload_id: str,
    request: Request,
    offset: int = Query(..., ge=0),
    member: dict = Depends(get_current_member),
):
    sess = _get_owned_session(project_id, upload_id, member)
    part = file_manager.upload_part_path(get_storage_root(), project_id, upload_id)
    current = _part_size(part)
    # The partial blob's size is the source of truth. A mismatched offset means the
    # client is out of sync (after a reconnect) — hand back the real offset so it resyncs.
    if offset != current:
        raise HTTPException(409, detail={"offset": current})

    data = await request.body()
    if not data:
        return {"offset": current}
    if current + len(data) > sess["total_size"]:
        raise HTTPException(413, detail="Chunk exceeds declared upload size")

    try:
        new_size = await file_manager.append_to_part(part, offset, data)
    except (FileNotFoundError, ValueError):
        raise HTTPException(409, detail={"offset": _part_size(part)})
    storage.set_upload_received(upload_id, new_size)
    return {"offset": new_size}


@app.delete("/projects/{project_id}/files/upload/{upload_id}")
async def upload_abort(
    project_id: int,
    upload_id: str,
    member: dict = Depends(get_current_member),
):
    _get_owned_session(project_id, upload_id, member)
    file_manager.delete_part(file_manager.upload_part_path(get_storage_root(), project_id, upload_id))
    storage.delete_upload_session(upload_id)
    return {"aborted": True}


@app.post("/projects/{project_id}/files/upload/{upload_id}/complete")
async def upload_complete(
    project_id: int,
    upload_id: str,
    member: dict = Depends(get_current_member),
):
    sess = _get_owned_session(project_id, upload_id, member)
    storage_root = get_storage_root()
    part = file_manager.upload_part_path(storage_root, project_id, upload_id)
    size = _part_size(part)
    if size != sess["total_size"]:
        raise HTTPException(400, detail=f"Incomplete upload: {size}/{sess['total_size']} bytes received")

    path = sess["file_path"]
    base_version = sess["base_version"]
    force = bool(sess["force"])
    message = sess["message"] or ""

    existing = storage.get_file_by_path(project_id, path)
    # Re-check lock/conflict — time passed since init, a teammate may have moved it.
    _assert_upload_allowed(existing, member, base_version, force)

    if existing:
        new_version = existing["current_version"] + 1
        file_id = existing["id"]
        expected_version = existing["current_version"]
    else:
        new_version = 1
        new_file = storage.create_file(project_id, path, 0, "")
        file_id = new_file["id"]
        expected_version = 1

    original_name = path.split("/")[-1]
    md5 = await asyncio.to_thread(file_manager.compute_md5, str(part))
    storage_filename = file_manager.make_storage_filename(file_id, new_version, original_name)
    dest = file_manager.get_file_path(storage_root, project_id, storage_filename)
    file_manager.finalize_part(part, dest)

    try:
        updated = storage.commit_new_version(
            file_id=file_id,
            expected_current_version=expected_version,
            new_version=new_version,
            size_bytes=size,
            checksum=md5,
            author_id=member["id"],
            message=message,
            storage_filename=storage_filename,
            locker_member_id=member["id"],
        )
    except Exception:
        dest.unlink(missing_ok=True)
        if not existing:
            storage.delete_file(file_id)
        storage.delete_upload_session(upload_id)
        raise

    if updated is None:
        dest.unlink(missing_ok=True)
        if not existing:
            storage.delete_file(file_id)
        storage.delete_upload_session(upload_id)
        raise HTTPException(409, detail={
            "conflict": True,
            "message": "Concurrent modification — refresh and retry",
        })

    storage.delete_upload_session(upload_id)
    storage.create_activity(
        project_id, member["id"], file_id, "upload", path, new_version,
        f"{member['name']} uploaded v{new_version}",
    )
    await ws_manager.broadcast(project_id, "uploaded", {
        "path": path, "version": new_version, "member": member["name"],
    }, exclude_member=member["id"])

    return updated


@app.get("/projects/{project_id}/files/download")
async def download_file(
    project_id: int,
    path: str = Query(...),
    version: int = Query(None),
    member: dict = Depends(get_current_member),
):
    project = storage.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    path = normalize_rel_path(path)
    file_record = storage.get_file_by_path(project_id, path)
    if not file_record:
        raise HTTPException(404, "File not found")

    if version:
        ver = storage.get_version(file_record["id"], version)
    else:
        ver = storage.get_latest_version(file_record["id"])

    if not ver:
        raise HTTPException(404, "Version not found")

    file_path = file_manager.get_file_path(get_storage_root(), project_id, ver["storage_filename"])
    if not file_path.exists():
        raise HTTPException(404, "File data not found on disk")

    # Log activity
    storage.create_activity(
        project_id, member["id"], file_record["id"], "download", path, ver["version"],
        f"{member['name']} downloaded v{ver['version']}",
    )

    headers = {
        "X-File-Version": str(ver["version"]),
        "X-File-Checksum": ver["checksum"],
    }

    # Stream large files
    if ver["size_bytes"] > 50 * 1024 * 1024:
        async def iter_file():
            with open(file_path, "rb") as f:
                while chunk := f.read(file_manager.CHUNK_SIZE):
                    yield chunk
        return StreamingResponse(
            iter_file(),
            media_type="application/octet-stream",
            headers=headers,
        )

    return FileResponse(
        path=str(file_path),
        filename=path.split("/")[-1] if "/" in path else path,
        headers=headers,
    )


def _read_latest_text_blob(project_id: int, file_record: dict, max_bytes: int = 5 * 1024 * 1024) -> str | None:
    """Read a tracked file's latest version as UTF-8 text (best-effort) for GUID
    scanning. Skips blobs larger than max_bytes to avoid loading big binaries."""
    ver = storage.get_latest_version(file_record["id"])
    if not ver:
        return None
    p = file_manager.get_file_path(get_storage_root(), project_id, ver["storage_filename"])
    if not p.exists() or p.stat().st_size > max_bytes:
        return None
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return None


_META_SCAN_CAP = 4000  # bound the per-request .meta blob scan for GUID lookups


def _build_meta_guid_map(project_id: int, server_files: list[dict]) -> dict[str, str]:
    """Index {guid -> meta_path} from the project's .meta files. A .meta's first
    `guid:` is its asset's id — the value referenced from prefabs/materials."""
    out: dict[str, str] = {}
    metas = [f for f in server_files if unity.is_meta_path(f["path"])]
    for f in metas[:_META_SCAN_CAP]:
        content = _read_latest_text_blob(project_id, f)
        if not content:
            continue
        # The asset's own guid is the first `guid:` in document order; later guids
        # (e.g. a model importer's material remaps) are references, not this asset.
        g = unity.first_unity_guid(content)
        if g:
            out[g] = f["path"]
    if len(metas) > _META_SCAN_CAP:
        logger.info("Unity GUID scan capped at %d of %d .meta files", _META_SCAN_CAP, len(metas))
    return out


@app.post("/projects/{project_id}/files/lock-suggestions")
async def lock_suggestions(
    project_id: int,
    body: PathRequest,
    member: dict = Depends(get_current_member),
):
    """Related Unity files to offer when locking `path` — its .meta, same-basename
    prefab/material/textures, and (for text assets) GUID-referenced dependencies."""
    project = storage.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    path = normalize_rel_path(body.path)

    server_files = storage.list_files(project_id)
    all_paths = [f["path"] for f in server_files]

    referenced: list[str] = []
    file_record = storage.get_file_by_path(project_id, path)
    if file_record and path.lower().endswith(unity.UNITY_TEXT_ASSET_EXTS):
        content = _read_latest_text_blob(project_id, file_record)
        guids = unity.scan_unity_guids(content) if content else set()
        if guids:
            referenced = unity.find_assets_by_unity_guids(guids, _build_meta_guid_map(project_id, server_files))

    suggestions = unity.build_lock_suggestion(path, all_paths, referenced=referenced)
    by_path = {f["path"]: f for f in server_files}
    for s in suggestions:
        rec = by_path.get(s["path"])
        # Flag files already locked by someone else so the dialog can disable them.
        if rec and rec["locked_by_id"] and rec["locked_by_id"] != member["id"]:
            s["locked_by"] = rec.get("locked_by_name") or "another member"
        else:
            s["locked_by"] = None
    return {"path": path, "is_meta": unity.is_meta_path(path), "suggestions": suggestions}


@app.post("/projects/{project_id}/files/lock")
async def lock_file(
    project_id: int,
    body: FileLockRequest,
    member: dict = Depends(get_current_member),
):
    primary = normalize_rel_path(body.path)
    file_record = storage.get_file_by_path(project_id, primary)
    if not file_record:
        raise HTTPException(404, "File not found")

    server_files = storage.list_files(project_id)
    known = {f["path"]: f for f in server_files}

    # Build the lock set: the primary, its .meta (auto-paired unless primary IS a
    # meta), plus any extra paths the client picked from the dependency dialog.
    to_lock = [primary]
    auto_meta = None
    if not unity.is_meta_path(primary):
        meta = unity.get_unity_meta_path(primary)
        if meta in known:
            auto_meta = meta
            to_lock.append(meta)
    for extra in body.also:
        e = normalize_rel_path(extra)
        if e in known and e not in to_lock:
            to_lock.append(e)

    group_id = secrets.token_hex(8) if len(to_lock) > 1 else None

    # Primary must lock successfully (423 otherwise).
    updated = storage.try_acquire_lock(file_record["id"], member["id"], body.reason, group_id)
    if updated is None:
        raise HTTPException(404, "File not found")
    if updated["locked_by_id"] != member["id"]:
        locker = storage.get_member(updated["locked_by_id"])
        raise HTTPException(423, detail={
            "locked": True,
            "locked_by": locker["name"] if locker else "Unknown",
            "locked_at": updated["locked_at"],
        })

    locked_paths = [primary]
    skipped = []
    for p in to_lock[1:]:
        rec = known[p]
        r = storage.try_acquire_lock(rec["id"], member["id"], body.reason, group_id)
        if r and r["locked_by_id"] == member["id"]:
            locked_paths.append(p)
        else:
            locker = storage.get_member(r["locked_by_id"]) if r and r["locked_by_id"] else None
            skipped.append({"path": p, "locked_by": locker["name"] if locker else "another member"})

    # One activity for the whole lock, with companions folded into the detail (so the
    # log shows a single grouped action rather than a row per auto-locked file).
    companions = [p for p in locked_paths if p != primary]
    detail = f"{member['name']} locked {primary}"
    if companions:
        names = ", ".join(p.split("/")[-1] for p in companions)
        detail += f" + {len(companions)} related ({names})"
    if body.reason:
        detail += f" — {body.reason}"
    storage.create_activity(project_id, member["id"], file_record["id"], "lock", primary, detail=detail)

    # A single broadcast is enough — peers refresh their file list and see every
    # locked file (and its group). group_size lets the live feed hint at the group.
    await ws_manager.broadcast(project_id, "locked", {
        "path": primary, "member": member["name"], "group_size": len(locked_paths),
    }, exclude_member=member["id"])

    return {
        "file": updated,
        "locked": locked_paths,
        "auto_meta": auto_meta,
        "also_locked": companions,
        "skipped": skipped,
        "group_id": group_id,
    }


@app.post("/projects/{project_id}/files/unlock")
async def unlock_file(
    project_id: int,
    body: FileLockRequest,
    member: dict = Depends(get_current_member),
):
    primary = normalize_rel_path(body.path)
    file_record = storage.get_file_by_path(project_id, primary)
    if not file_record:
        raise HTTPException(404, "File not found")

    group_id = file_record.get("lock_group_id")

    # Atomic release (B5): only releases if held by member
    updated, released = storage.try_release_lock(file_record["id"], member["id"])
    if updated is None:
        raise HTTPException(404, "File not found")
    if not released:
        raise HTTPException(403, "File locked by another member")

    released_paths = [primary]
    if body.scope == "group" and group_id:
        # Release the whole lock-group the member holds (e.g. door.fbx + its .meta).
        for f in storage.list_files(project_id):
            if f["path"] != primary and f.get("lock_group_id") == group_id and f["locked_by_id"] == member["id"]:
                _, rel = storage.try_release_lock(f["id"], member["id"])
                if rel:
                    released_paths.append(f["path"])
    elif group_id:
        # Single-file unlock from a group: if only one locked file is left in the
        # group, it's no longer a group — clear its group_id so the UI stops showing
        # the shared indicator.
        remaining = [f for f in storage.list_files(project_id)
                     if f.get("lock_group_id") == group_id and f["locked_by_id"] is not None]
        if len(remaining) == 1:
            storage.update_file(remaining[0]["id"], lock_group_id=None)

    # One activity + one broadcast for the unlock (companions folded into the detail).
    detail = f"{member['name']} unlocked {primary}"
    if len(released_paths) > 1:
        detail += f" + {len(released_paths) - 1} related"
    storage.create_activity(project_id, member["id"], file_record["id"], "unlock", primary, detail=detail)
    await ws_manager.broadcast(project_id, "unlocked", {
        "path": primary, "member": member["name"],
    }, exclude_member=member["id"])

    return updated


@app.post("/projects/{project_id}/files/revert")
async def revert_file(
    project_id: int,
    body: FileRevertRequest,
    member: dict = Depends(get_current_member),
):
    body.path = normalize_rel_path(body.path)
    file_record = storage.get_file_by_path(project_id, body.path)
    if not file_record:
        raise HTTPException(404, "File not found")

    target_version = storage.get_version(file_record["id"], body.version)
    if not target_version:
        raise HTTPException(404, "Target version not found")

    # Lock check (V2): revert must respect locks like upload does (423).
    if file_record["locked_by_id"] and file_record["locked_by_id"] != member["id"]:
        locker = storage.get_member(file_record["locked_by_id"])
        raise HTTPException(423, detail={
            "locked": True,
            "locked_by": locker["name"] if locker else "Unknown",
            "locked_at": file_record["locked_at"],
        })

    new_version_num = file_record["current_version"] + 1
    src_path = file_manager.get_file_path(get_storage_root(), project_id, target_version["storage_filename"])
    if not src_path.exists():
        raise HTTPException(404, "Target version file not found on disk")

    # Copy the target blob under the new version's filename.
    original_name = body.path.split("/")[-1] if "/" in body.path else body.path
    new_filename = file_manager.make_storage_filename(file_record["id"], new_version_num, original_name)
    dest_dir = file_manager.get_storage_dir(get_storage_root(), project_id)
    new_blob_path = dest_dir / new_filename
    # Off-load the blob copy to a thread — a multi-GB revert must not block the event
    # loop (M1; mirrors the streaming/to_thread handling on the upload path).
    await asyncio.to_thread(shutil.copy2, str(src_path), str(new_blob_path))

    # Atomic version commit (V2): same path as upload_file — asserts no foreign lock
    # and that current_version still matches, replacing the non-atomic
    # create_version + update_file that could race with a concurrent upload.
    try:
        updated = storage.commit_new_version(
            file_id=file_record["id"],
            expected_current_version=file_record["current_version"],
            new_version=new_version_num,
            size_bytes=target_version["size_bytes"],
            checksum=target_version["checksum"],
            author_id=member["id"],
            message=f"Reverted to v{body.version}",
            storage_filename=new_filename,
            locker_member_id=member["id"],
        )
    except Exception:
        new_blob_path.unlink(missing_ok=True)
        raise

    if updated is None:
        new_blob_path.unlink(missing_ok=True)
        raise HTTPException(409, detail={
            "conflict": True,
            "message": "Concurrent modification — refresh and retry",
        })

    storage.create_activity(
        project_id, member["id"], file_record["id"], "revert", body.path,
        new_version_num, f"{member['name']} reverted to v{body.version}",
    )

    await ws_manager.broadcast(project_id, "reverted", {
        "path": body.path, "version": body.version, "member": member["name"],
    }, exclude_member=member["id"])

    return updated



@app.get("/projects/{project_id}/files/versions")
async def list_file_versions(
    project_id: int,
    path: str = Query(...),
    member: dict = Depends(get_current_member),
):
    path = normalize_rel_path(path)
    file_record = storage.get_file_by_path(project_id, path)
    if not file_record:
        raise HTTPException(404, "File not found")
    return storage.list_versions(file_record["id"])


@app.delete("/projects/{project_id}/files")
async def delete_file(
    project_id: int,
    path: str = Query(...),
    member: dict = Depends(get_current_member),
):
    path = normalize_rel_path(path)
    file_record = storage.get_file_by_path(project_id, path)
    if not file_record:
        raise HTTPException(404, "File not found")

    if file_record["locked_by_id"] and file_record["locked_by_id"] != member["id"]:
        raise HTTPException(423, "File is locked by another member")

    # Get all version filenames for cleanup
    versions = storage.list_versions(file_record["id"])
    filenames = [v["storage_filename"] for v in versions]
    file_manager.delete_file_versions(get_storage_root(), project_id, file_record["id"], filenames)

    storage.delete_file(file_record["id"])

    storage.create_activity(
        project_id, member["id"], None, "delete", path,
        detail=f"{member['name']} deleted {path}",
    )

    return {"ok": True}


# ── Server Settings ──────────────────────────────────────────────────

class SettingsUpdate(BaseModel):
    storage_root: str | None = None
    auto_unlock_hours: str | None = None
    max_file_size_mb: str | None = None

@app.get("/settings")
async def get_settings(member: dict = Depends(get_current_member)):
    return {
        "storage_root": storage.get_setting("storage_root", STORAGE_ROOT),
        "auto_unlock_hours": storage.get_setting("auto_unlock_hours", "24"),
        "server_version": storage.get_setting("server_version", "0.1.0"),
        "max_file_size_mb": storage.get_setting("max_file_size_mb", "2048"),
    }

@app.put("/settings")
async def update_settings(
    body: SettingsUpdate,
    member: dict = Depends(get_current_member),
    _admin: None = Depends(require_admin),
):
    if body.storage_root is not None:
        storage.set_setting("storage_root", body.storage_root)
    if body.auto_unlock_hours is not None:
        storage.set_setting("auto_unlock_hours", body.auto_unlock_hours)
    if body.max_file_size_mb is not None:
        storage.set_setting("max_file_size_mb", body.max_file_size_mb)
    return await get_settings(member)


# ── Activity ─────────────────────────────────────────────────────────

@app.get("/projects/{project_id}/activity")
async def list_activity(
    project_id: int,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    member: dict = Depends(get_current_member),
):
    return storage.list_activity(project_id, limit, offset)


# ── WebSocket ────────────────────────────────────────────────────────

@app.websocket("/projects/{project_id}/ws")
async def websocket_endpoint(websocket: WebSocket, project_id: int):
    # Auth via the first message instead of the query string, so the API key never
    # lands in access logs / proxy URLs (S2). Expect {"type":"auth","member_name","api_key"}.
    await websocket.accept()
    ip = websocket.client.host if websocket.client else "unknown"
    if not _rate_limit_ws(ip):
        await websocket.close(code=4001, reason="Too many auth attempts")
        return
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        msg = json.loads(raw)
    except (asyncio.TimeoutError, WebSocketDisconnect, json.JSONDecodeError, ValueError):
        await websocket.close(code=4001, reason="Expected auth message")
        return

    if not isinstance(msg, dict) or msg.get("type") != "auth":
        await websocket.close(code=4001, reason="Expected auth message")
        return

    member_name = (msg.get("member_name") or "").strip()
    api_key = msg.get("api_key") or ""
    member = storage.get_member_by_name(member_name, include_key=True)
    expected_hash = (member or {}).get("api_key", "") or ""
    if not member or not api_key or not secrets.compare_digest(storage.hash_api_key(api_key), expected_hash):
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await ws_manager.connect(websocket, project_id, member["id"], accept=False)
    try:
        while True:
            data = await websocket.receive_text()
            if data == '{"type":"ping"}' or '"ping"' in data:
                await websocket.send_text('{"type":"pong"}')
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket, project_id, member["id"])


# ── Auto-unlock background task ──────────────────────────────────────

async def _auto_unlock_loop():
    while True:
        try:
            hours = int(storage.get_setting("auto_unlock_hours", "24"))
            expired = storage.get_expired_locks(hours)
            for file_rec in expired:
                storage.unlock_file(file_rec["id"])
                storage.create_activity(
                    file_rec["project_id"], None, file_rec["id"], "unlock",
                    file_rec["path"], detail=f"Auto-unlocked (timeout {hours}h)",
                )
                await ws_manager.broadcast(file_rec["project_id"], "unlocked", {
                    "path": file_rec["path"], "member": "System (auto-unlock)",
                })
        except Exception:
            logger.exception("Auto-unlock loop error")

        # Keep the in-memory rate-limit maps bounded (M2/M3).
        try:
            _gc_rate_limit_buckets()
        except Exception:
            logger.exception("Rate-limit GC error")

        # GC abandoned resumable uploads (partial blob + session row).
        try:
            ttl = int(storage.get_setting("upload_session_ttl_hours", "24"))
            for sess in storage.get_stale_upload_sessions(ttl):
                part = file_manager.upload_part_path(
                    get_storage_root(), sess["project_id"], sess["id"],
                )
                file_manager.delete_part(part)
                storage.delete_upload_session(sess["id"])
        except Exception:
            logger.exception("Upload-session GC error")

        await asyncio.sleep(3600)  # every hour


# ── Entry point ──────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.main:app", host="0.0.0.0", port=PORT, reload=True)
