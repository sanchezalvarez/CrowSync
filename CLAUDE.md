# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

CrowSync is a SVN-inspired file versioning + locking tool for game-dev teams (Unity/Godot/Unreal binary assets). It is split into three deployables that all live in this repo:

- **`server/`** — Python FastAPI backend (SQLite + on-disk versioned blobs). Single source of truth.
- **`src/`** — React 19 + Vite + Tailwind v4 frontend (the UI).
- **`src-tauri/`** — Tauri v2 Rust shell that wraps `src/` as a desktop app. The browser dev build talks to the same backend, so most UI work doesn't need Tauri running.

## Commands

### Backend (run from repo root)
```bash
pip install -r server/requirements.txt
python -m server.main          # serves on :8001, reload enabled
```
Env vars: `CROWSYNC_PORT`, `CROWSYNC_DB_PATH`, `CROWSYNC_STORAGE_ROOT` (defaults: `8001`, `./crowsync.db`, `./storage`) and `CROWSYNC_ADMIN_TOKEN` (empty by default — required to register members after the first one, see Auth model).

### Frontend
```bash
npm run dev        # Vite on :1420 (strictPort — must be free)
npm run build      # tsc -b && vite build → dist/
npm run lint       # eslint .
npm run type-check # tsc --noEmit (no emit, just type errors)
npm run tauri dev  # full desktop app (also boots vite via beforeDevCommand)
```
There is **no test runner configured** — don't claim tests pass; verify changes by running the dev server and exercising the UI.

### Docker (production-style backend)
```bash
docker-compose up -d   # backend on :8001, data in named volume `crowsync-data`
```

## Architecture

### Auth model
Every request needs **two headers**: `X-Member-Name` and `X-Api-Key`. The API key is generated server-side on `POST /members` and is the *only* time it's returned — the frontend stashes it in `localStorage` (keys: `crowsync_server_url`, `crowsync_member_name`, `crowsync_member_id`, `crowsync_api_key`). Only a **SHA-256 hash** of the key is stored in the DB (`storage.hash_api_key`); `get_current_member` hashes the incoming key and `compare_digest`s it (a legacy-plaintext migration in `init_db` hashes old 32-char keys in place). WebSocket auth is sent in the **first message** after connect (`{"type":"auth","member_name":…,"api_key":…}`), not the query string, so keys don't leak into access logs. `server/main.py:get_current_member` gates everything except `/health` and `POST /members`.

`POST /members` is gated by `require_admin_or_bootstrap`: the **first** member registers freely (bootstrap mode); afterwards it must carry `X-Admin-Token` matching `CROWSYNC_ADMIN_TOKEN` (and is rate-limited per IP via `_rate_limit_members`). Re-posting an existing name (with a valid token) **issues a fresh key** via `storage.reset_member_key` — the original can't be returned since only the hash is stored, so recovery invalidates the old machine's key. The admin token is a master key to every account. The setup UI (`App.tsx:handleSetup`) sends the admin token and persists it as `crowsync_admin_token`.

**Destructive endpoints** (`DELETE /projects/{id}`, `DELETE /members/{id}`, `PUT /settings`) additionally require `X-Admin-Token` via the strict `require_admin` dependency (no bootstrap). `client.ts:headers()` attaches `crowsync_admin_token` from localStorage to every request when present (harmless on non-admin routes).

### Data layer
- **`server/storage.py`** is the only module that touches SQLite — raw `sqlite3`, no ORM. Every state-changing endpoint goes through it; don't open connections elsewhere. Read-modify-write sequences that must be atomic across concurrent requests (e.g. lock check + flip in `upload_file`) use the `with_transaction()` context manager, which serializes via a process-wide write-lock + `BEGIN IMMEDIATE`.
- `server/file_manager.py` is the on-disk/blob + path-logic counterpart (scan, ignore patterns, storage filenames). `server/main.py` is routing/HTTP only and delegates to these two.
- `server/unity.py` holds the Unity-aware helpers (pure path/content functions, no I/O — see "Unity-aware features" below); `server/test_unity.py` covers them (`python -m server.test_unity`).

### Storage layout
- **DB schema (`server/schema.sql`, applied by `storage.init_db`)**: `projects`, `members`, `files` (current state + lock metadata: `locked_by_id`, `locked_at`, `lock_reason`, `lock_group_id`), `versions` (history), `activity` (audit log), `settings` (key/value), `upload_sessions` (resumable uploads). Files locked together (an asset + its `.meta` + picked deps) share a `lock_group_id`. Unlock takes a `scope` (`"file"` | `"group"`); the UI asks which when you unlock a grouped file. A single-file unlock that leaves one member behind clears that member's `lock_group_id` (no longer a group).
- **Blobs**: `{storage_root}/{project_id}/files/{file_id}_v{version}_{sanitized_name}` — see `server/file_manager.py:make_storage_filename`. Storage root is configurable at runtime via the `storage_root` setting (overrides the env var) so admins can point at a network share without restarting.
- The member's **local working folder is a client-side concern**: each member keeps their own copy, so the path lives in the client's `localStorage` (`crowsync_local_path_{projectId}`, see `src/utils/localPath.ts`), **not** on the server. The legacy `project.root_path` column still exists but the server no longer reads it for sync.

### The sync flow (critical to understand before editing)
**Distributed / client-side model.** The server is a dumb blob+metadata store and never reads a member's disk. The Tauri client owns the intelligence:
- **Scan** happens natively in Rust (`src-tauri/src/fs_ops.rs:scan_dir` — walkdir + MD5, mirrors `file_manager.DEFAULT_IGNORE_PATTERNS` via `GET /ignore-patterns`).
- **`POST /projects/{id}/compare`** takes a client-supplied **manifest** (`{files:[{path,checksum,size_bytes}]}`) and diffs it against the DB — it does *not* scan anything server-side. Returns the same `CompareResult` shape the UI already consumes.
- **Push/pull are orchestrated on the client** (`src/hooks/useFileWatch.ts`): push loops over `new_local`+`modified_local` calling the native streaming upload (`fs_ops.rs:upload_file` → `POST .../files/upload`); pull loops over `new_remote` calling `fs_ops.rs:download_file` (streams a version straight to disk). Both reuse the member's API key.
- All per-file actions (upload/download/lock/unlock/revert/versions) live under `/projects/{id}/files/...`.
- **Browser dev mode has no Tauri** → native scan/transfer are unavailable, `useFileWatch` stays idle (`native:false`) and the UI degrades to read-only (lock/download/activity still work).

Conflict + lock semantics on upload (`server/main.py:upload_file`):
- HTTP **423** if file is locked by another member.
- HTTP **409** if `base_version` < server's `current_version` (stale base) and `force` is false; client should surface a conflict dialog and re-upload with `force=true`.
- HTTP **413** if size exceeds `max_file_size_mb` setting (default 2048).

**Resumable upload (tus-lite).** The native client uses a 3-step session flow so a dropped connection resumes instead of restarting a multi-GB transfer: `POST .../files/upload/init` (fail-fast 423/409/413 + opens a session, optional client-supplied `upload_id`) → `PATCH .../upload/{id}?offset=N` chunks (the **partial blob's on-disk size is the authoritative offset**; a mismatch returns 409 with the real offset) → `POST .../upload/{id}/complete` (md5 + atomic `commit_new_version` + rename `.part`→final). State: `upload_sessions` table (storage.py), partials at `{storage_root}/{pid}/uploads/{id}.part` (file_manager.py), GC of stale sessions in `_auto_unlock_loop` (`upload_session_ttl_hours`). The legacy multipart `/files/upload` endpoint stays for the **browser UI** (`client.uploadFile`). Cross-restart resume: the client persists its `upload_id` per path in `src/utils/uploadState.ts` and passes it to `fs_ops.rs:upload_file`, which tries `GET status` first (resume) and falls back to `init` (404). Shared lock/conflict gate: `main.py:_assert_upload_allowed`.

### Real-time
`server/websocket_manager.py` broadcasts `uploaded` / `locked` / `unlocked` / `reverted` events per project. The originating member is excluded via `exclude_member`. The WS endpoint `accept()`s first, then waits (10 s) for the `{"type":"auth",…}` first message before registering — `ws_manager.connect(..., accept=False)`. Frontend: `src/api/websocket.ts` sends that auth frame on `onopen`. Hook `src/hooks/useWebSocket.ts` is consumed by `SyncPage` and propagated into `useFiles` so the file list refreshes on remote changes. Background task `_auto_unlock_loop` in `main.py` runs hourly: releases locks older than `auto_unlock_hours` **and** GCs abandoned upload sessions.

### Unity-aware features
For Unity projects (`Assets/` + `ProjectSettings/`), CrowSync adds locking/ignore intelligence. Logic lives in `server/unity.py` (pure functions on path strings + file content — easy to test, not a Unity importer; GUID handling is a best-effort regex scan).
- **Detection + ignore**: client-side. Rust `fs_ops.rs:detect_unity(root)` checks for `Assets/`+`ProjectSettings/` locally (pre-sync, since the server can't see the disk). When detected, `useFileWatch` merges `GET /unity-ignore-patterns` (`unity.UNITY_IGNORE_PATTERNS` — `Library/`, `Temp/`, `*.csproj`…) into the native scan and `SyncPage` shows the "Unity project detected" badge.
- **`.meta` pairing + lock groups**: `POST .../files/lock` takes `{path, reason, also[]}`. The server auto-adds the asset's `.meta` (if tracked), locks `also[]` picks, assigns a shared `lock_group_id`, and returns `{file, locked, auto_meta, also_locked, skipped, group_id}`. The lock writes **one grouped `lock` activity** (companions folded into the detail) + one broadcast. `POST .../files/unlock {path, scope}` releases just the file or the whole group; `FileDetail` shows the group (title + member list) and `UnlockGroupDialog` asks the scope.
- **Dependency suggestions**: `POST .../files/lock-suggestions {path}` → `{is_meta, suggestions:[{path, checked, locked_by}]}` from same-basename neighbours (`unity.find_same_basename_dependencies`) + GUID refs in text assets (`.prefab/.mat/.unity/.asset`: `unity.scan_unity_guids` → `_build_meta_guid_map` over `.meta` blobs → referenced assets). UI: `LockDialog` (reason textarea + checkbox list; `.meta`-only lock shows a warning).
- **Push safety**: `/compare` returns `unity:{is_unity, warnings}` for asset/`.meta` out-of-sync changes (`unity.validate_unity_push_safety`); `SyncPage` also derives "edited a scene/prefab without a lock" client-side and shows a non-blocking warnings bar. Deleting one half of an asset/`.meta` pair prompts a warning.

### Frontend structure
- `src/api/client.ts` — single `CrowSyncClient` class wrapping every endpoint. **Always extend this** rather than calling `fetch` from components.
- `src/types/index.ts` — shared TS types matching server responses. Keep in sync when changing API shapes.
- `src/hooks/` — one hook per concern: `useProjects`, `useFiles`, `useFileWatch` (native scan → manifest → `/compare`, 5s poll; also owns client-side push/pull), `useSyncStatus`, `useWebSocket`, `useToast`.
- `src/utils/nativeFs.ts` — bridge to the Rust commands (`scan_dir`/`upload_file`/`download_file`) with a browser fallback; `src/utils/localPath.ts` — per-project local folder mapping.
- `src/pages/SyncPage.tsx` — composes everything; the only "page" in the app. `App.tsx` only handles the setup/settings screens before handing off.
- `src/components/CrowSync/` — feature components (FileTree, FileDetail, ActivityFeed, ConflictDialog, etc.).

### Styling
Tailwind v4 with a custom theme in `src/index.css` (`@theme` block). Use the named tokens (`bg-surface-1`, `text-text-muted`, `text-accent`, `text-sync`, `text-danger`, `text-locked`, `font-mono`, `scanlines`) instead of raw colors so the dark-industrial look stays consistent.

### Tauri
The Rust side (`src-tauri/src/lib.rs`) registers `tauri-plugin-dialog` (path picking, via `src/utils/folderPicker.ts`) plus three custom commands in `src-tauri/src/fs_ops.rs` that power client-side sync: `scan_dir` (walkdir + MD5 manifest), `upload_file` / `download_file` (streaming transfers via `reqwest`, chunked so multi-GB assets don't sit in RAM). Custom commands need no capability entry; the `fs:*` scope in `tauri.conf.json` only matters if `tauri-plugin-fs` is used directly. Frontend assumes Tauri APIs may be absent (browser dev mode) — keep that fallback when adding native calls.

## Known issues (see AUDIT.md for details)

Full audit lives in `AUDIT.md`. As of **2026-06-13** the audit's findings are resolved:

- **K1** (client-side sync base), **V1–V4** (auto-unlock time format, atomic+lock-checked revert, setup admin-token UI, compose `CROWSYNC_ADMIN_TOKEN`), **N1–N8** — fixed 2026-06-12.
- **Resumable upload**, **S1** (admin-gated destructive endpoints), **S2a** (API-key hashing), **S2b** (WS auth out of the query string), **rate-limit on `/members`** — done 2026-06-13.

Remaining / operational:
- **TLS (S3)** is deployment-level, not code — run behind the included Caddy reverse proxy (`Caddyfile` + `docker-compose.tls.yml`) before exposing the server to the internet. Keys travel in headers/WS message, so TLS is mandatory in production.
- **S4** — the admin token is a master key (recovery re-issues any member's key); keep it secret. **S5** — MD5 is change-detection, not tamper-resistance (informational).

## Conventions worth following
- Server CORS allows `localhost:1420` (Vite), `localhost:5173`, and `tauri://localhost`. Add new origins there if you change the dev port.
- `DEFAULT_IGNORE_PATTERNS` in `server/file_manager.py` is the source of truth for what gets skipped during scan — extend it there, not in the client.
- Activity log entries are written for every state-changing endpoint; mirror that pattern when adding new actions so the `ActivityFeed` stays complete.
- All file-path strings on the wire use forward slashes and are relative to `project.root_path`; don't introduce backslashes even on Windows.
