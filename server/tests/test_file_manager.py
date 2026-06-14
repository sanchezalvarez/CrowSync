"""Unit tests for server/file_manager.py — pure I/O, no DB or HTTP."""

import hashlib
import pytest
from pathlib import Path

from server import file_manager


def test_sanitize_filename_strips_unsafe_chars():
    assert file_manager.sanitize_filename('a<b>c:d"e/f\\g|h?i*j') == "a_b_c_d_e_f_g_h_i_j"


def test_sanitize_filename_leaves_safe_chars():
    name = "model_v2.fbx"
    assert file_manager.sanitize_filename(name) == name


def test_make_storage_filename_format():
    fname = file_manager.make_storage_filename(7, 3, "hero.fbx")
    assert fname == "7_v3_hero.fbx"


def test_make_storage_filename_sanitizes_name():
    fname = file_manager.make_storage_filename(1, 1, "bad/name.txt")
    assert "/" not in fname
    assert fname.startswith("1_v1_")


def test_compute_md5_known_value(tmp_path):
    data = b"hello crowsync"
    f = tmp_path / "sample.bin"
    f.write_bytes(data)
    expected = hashlib.md5(data).hexdigest()
    assert file_manager.compute_md5(str(f)) == expected


async def test_append_to_part_offset_mismatch_raises(tmp_path):
    storage_root = str(tmp_path)
    part = file_manager.create_empty_part(storage_root, 1, "aabbcc")
    with pytest.raises(ValueError, match="offset mismatch"):
        await file_manager.append_to_part(part, expected_offset=10, data=b"xyz")


async def test_append_to_part_sequential_chunks(tmp_path):
    storage_root = str(tmp_path)
    part = file_manager.create_empty_part(storage_root, 1, "ddeeff")
    size = await file_manager.append_to_part(part, expected_offset=0, data=b"hello")
    assert size == 5
    size = await file_manager.append_to_part(part, expected_offset=5, data=b" world")
    assert size == 11
    assert part.read_bytes() == b"hello world"


def test_create_and_finalize_part(tmp_path):
    storage_root = str(tmp_path)
    uid = "00112233445566778899aabbccddeeff"
    part = file_manager.create_empty_part(storage_root, 2, uid)
    assert part.exists()
    assert part.stat().st_size == 0

    part.write_bytes(b"complete content")
    dest = tmp_path / "2" / "files" / "final_v1_file.bin"
    dest.parent.mkdir(parents=True, exist_ok=True)
    file_manager.finalize_part(part, dest)
    assert dest.exists()
    assert not part.exists()


def test_delete_project_storage(tmp_path):
    storage_root = str(tmp_path)
    # Create some structure inside project 5
    proj_dir = tmp_path / "5"
    (proj_dir / "files").mkdir(parents=True)
    (proj_dir / "files" / "1_v1_foo.bin").write_bytes(b"data")
    file_manager.delete_project_storage(storage_root, 5)
    assert not proj_dir.exists()
