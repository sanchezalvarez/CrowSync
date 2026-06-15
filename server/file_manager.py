"""File storage operations for CrowSync — streaming I/O, MD5, ignore patterns."""

import hashlib
import re
from pathlib import Path

CHUNK_SIZE = 8 * 1024 * 1024  # 8 MB

DEFAULT_IGNORE_PATTERNS = [
    "*.tmp", "*.temp", "*.log",
    ".git/", ".svn/", ".hg/",           # VCS metadata (can be huge)
    "Temp/", "Library/", "Logs/",      # Unity
    ".godot/", "export/",               # Godot
    "Binaries/", "Build/", "Saved/",    # Unreal
    "node_modules/", "__pycache__/",
    ".DS_Store", "Thumbs.db",
    "*.pyc", "*.pyo",
]


def sanitize_filename(name: str) -> str:
    """Remove or replace characters unsafe for filenames."""
    return re.sub(r'[<>:"/\\|?*]', '_', name)


def get_storage_dir(storage_root: str, project_id: int) -> Path:
    """Return the storage directory for a project's files."""
    p = Path(storage_root) / str(project_id) / "files"
    p.mkdir(parents=True, exist_ok=True)
    return p


def make_storage_filename(file_id: int, version: int, original_name: str) -> str:
    """Build the on-disk filename: {file_id}_v{version}_{sanitized_name}."""
    safe = sanitize_filename(original_name)
    return f"{file_id}_v{version}_{safe}"


class UploadTooLarge(Exception):
    """Raised when an upload exceeds max_bytes during streaming."""


async def save_file_streaming(
    storage_root: str, project_id: int, file_id: int,
    version: int, original_name: str, upload_file,
    max_bytes: int | None = None,
) -> tuple[str, str, int]:
    """
    Stream an uploaded file to disk in chunks.
    Returns (storage_filename, md5_checksum, size_bytes).
    Raises UploadTooLarge if max_bytes is set and exceeded mid-stream.
    """
    import aiofiles

    storage_dir = get_storage_dir(storage_root, project_id)
    filename = make_storage_filename(file_id, version, original_name)
    file_path = storage_dir / filename

    md5 = hashlib.md5()
    size = 0

    async with aiofiles.open(file_path, "wb") as f:
        while True:
            chunk = await upload_file.read(CHUNK_SIZE)
            if not chunk:
                break
            size += len(chunk)
            if max_bytes is not None and size > max_bytes:
                # Stop streaming immediately; caller is responsible for unlink + DB cleanup.
                raise UploadTooLarge(f"{size} bytes written, limit {max_bytes}")
            await f.write(chunk)
            md5.update(chunk)

    return filename, md5.hexdigest(), size


def get_file_path(storage_root: str, project_id: int, storage_filename: str) -> Path:
    """Return full path to a stored file version."""
    return get_storage_dir(storage_root, project_id) / storage_filename


# ── Resumable upload partials ────────────────────────────────────────

def get_uploads_dir(storage_root: str, project_id: int) -> Path:
    """Directory holding in-flight partial uploads for a project."""
    p = Path(storage_root) / str(project_id) / "uploads"
    p.mkdir(parents=True, exist_ok=True)
    return p


def upload_part_path(storage_root: str, project_id: int, upload_id: str) -> Path:
    """On-disk path of a resumable upload's partial blob ({upload_id}.part)."""
    return get_uploads_dir(storage_root, project_id) / f"{upload_id}.part"


def create_empty_part(storage_root: str, project_id: int, upload_id: str) -> Path:
    """Create (truncate) the partial blob for a fresh upload session."""
    part = upload_part_path(storage_root, project_id, upload_id)
    part.write_bytes(b"")
    return part


async def append_to_part(part_path: Path, expected_offset: int, data: bytes) -> int:
    """Append `data` to the partial blob, asserting it currently has `expected_offset`
    bytes (so a replayed chunk can't corrupt the file). Returns the new size."""
    import aiofiles

    if not part_path.exists():
        raise FileNotFoundError(str(part_path))
    current = part_path.stat().st_size
    if current != expected_offset:
        raise ValueError(f"offset mismatch: part has {current}, chunk expects {expected_offset}")
    async with aiofiles.open(part_path, "ab") as f:
        await f.write(data)
    return current + len(data)


def finalize_part(part_path: Path, dest_path: Path) -> None:
    """Move a completed partial blob to its final versioned filename."""
    part_path.replace(dest_path)


def delete_part(part_path: Path) -> None:
    """Remove a partial blob, ignoring absence."""
    part_path.unlink(missing_ok=True)


def compute_md5(file_path: str) -> str:
    """Compute MD5 checksum of a file in chunks (for large files)."""
    md5 = hashlib.md5()
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(CHUNK_SIZE)
            if not chunk:
                break
            md5.update(chunk)
    return md5.hexdigest()


def delete_project_storage(storage_root: str, project_id: int) -> None:
    """Delete all stored files for a project."""
    import shutil
    project_dir = Path(storage_root) / str(project_id)
    if project_dir.exists():
        shutil.rmtree(project_dir)


def delete_file_versions(storage_root: str, project_id: int, file_id: int, filenames: list[str]) -> None:
    """Delete specific version files from disk."""
    storage_dir = get_storage_dir(storage_root, project_id)
    for filename in filenames:
        path = storage_dir / filename
        if path.exists():
            path.unlink()
