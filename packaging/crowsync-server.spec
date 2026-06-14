# PyInstaller spec for the standalone CrowSync server binary.
#
# Produces a single self-contained executable (no Python install needed) for the
# host OS. The release workflow runs this on macOS, Windows, and Linux runners.
#
#   pyinstaller packaging/crowsync-server.spec      # → dist/crowsync-server[.exe]
#
# A .spec (not raw CLI flags) is used so the data-file separator and uvicorn's
# dynamically-imported submodules are handled identically on every OS.
import os

from PyInstaller.utils.hooks import collect_all, collect_submodules

# Anchor every path to the spec's location so the build works regardless of the
# directory pyinstaller is invoked from. SPECPATH is the packaging/ dir; ROOT is
# the repo root one level up.
ROOT = os.path.dirname(os.path.abspath(SPECPATH))

# uvicorn/anyio import their protocol + loop backends dynamically, so static
# analysis misses them — pull them in explicitly.
datas, binaries, hiddenimports = collect_all("uvicorn")
hiddenimports += collect_submodules("websockets")
hiddenimports += ["anyio._backends._asyncio"]

# init_db reads server/schema.sql via Path(__file__).parent — ship it next to the
# bundled `server` package so the lookup resolves inside the one-file extract.
datas += [(os.path.join(ROOT, "server", "schema.sql"), "server")]

a = Analysis(
    [os.path.join(SPECPATH, "server_entry.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="crowsync-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    onefile=True,
)
