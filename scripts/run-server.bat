@echo off
REM Run the CrowSync server natively on Windows (no Docker needed).
REM Creates a local virtualenv on first run, installs deps, then starts the server.
REM
REM   scripts\run-server.bat
REM
REM Configure via env vars before running (all optional - defaults shown):
REM   set CROWSYNC_PORT=8001
REM   set CROWSYNC_DB_PATH=.\crowsync.db
REM   set CROWSYNC_STORAGE_ROOT=.\storage
REM   set CROWSYNC_ADMIN_TOKEN=        (required to add members after the first one)
setlocal

cd /d "%~dp0\.."

set "VENV=.venv"

if not exist "%VENV%" (
  echo Creating virtualenv in %VENV% ...
  python -m venv "%VENV%"
)

call "%VENV%\Scripts\activate.bat"

echo Installing/updating dependencies ...
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r server\requirements.txt

if "%CROWSYNC_PORT%"=="" set "CROWSYNC_PORT=8001"
echo Starting CrowSync server on port %CROWSYNC_PORT% ...
python -m server.main
