#!/usr/bin/env bash
# Run the CrowSync server natively on macOS or Linux (no Docker needed).
# Creates a local virtualenv on first run, installs deps, then starts the server.
#
#   ./scripts/run-server.sh
#
# Configure via env vars before running (all optional — defaults shown):
#   CROWSYNC_PORT=8001
#   CROWSYNC_DB_PATH=./crowsync.db
#   CROWSYNC_STORAGE_ROOT=./storage
#   CROWSYNC_ADMIN_TOKEN=        # required to add members after the first one
set -euo pipefail

cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-python3}"
VENV=".venv"

if [ ! -d "$VENV" ]; then
  echo "Creating virtualenv in $VENV ..."
  "$PYTHON" -m venv "$VENV"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "Installing/updating dependencies ..."
pip install --quiet --upgrade pip
pip install --quiet -r server/requirements.txt

echo "Starting CrowSync server on port ${CROWSYNC_PORT:-8001} ..."
exec python -m server.main
