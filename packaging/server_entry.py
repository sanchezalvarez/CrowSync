"""Frozen-binary entry point for the CrowSync server (PyInstaller).

The module-level `server/main.py` launcher uses `reload=True` with an import
string (`"server.main:app"`), which needs the source tree on disk and a worker
subprocess — neither works inside a one-file PyInstaller bundle. This entry runs
the already-imported `app` object directly with reload disabled, which is also
what you want for a production/standalone server.

Build: `pyinstaller packaging/crowsync-server.spec` (from the repo root).
Run:   `./dist/crowsync-server` — reads the same CROWSYNC_* env vars as the
       `python -m server.main` path (port 8001, ./crowsync.db, ./storage).
"""
import uvicorn

from server.main import app, PORT

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, reload=False)
