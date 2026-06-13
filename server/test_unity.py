"""Tests for server/unity.py path matching + dependency detection.

Run directly (no pytest needed):  python -m server.test_unity
Or with pytest if available:      pytest server/test_unity.py
"""

from server import unity


def test_is_unity_project():
    assert unity.is_unity_project(["Assets/Scenes/Main.unity", "ProjectSettings/ProjectVersion.txt"])
    assert unity.is_unity_project(["Assets", "ProjectSettings"])
    assert not unity.is_unity_project(["Assets/Models/door.fbx"])           # no ProjectSettings
    assert not unity.is_unity_project(["ProjectSettings/x.asset"])          # no Assets
    assert not unity.is_unity_project(["src/main.py", "README.md"])
    # "Assetsfoo/" must not count as Assets/
    assert not unity.is_unity_project(["Assetsfoo/x", "ProjectSettings/y"])


def test_should_ignore_unity_path():
    ignore = unity.should_ignore_unity_path
    assert ignore("Library/foo.bin")
    assert ignore("Assets/Sub/Temp/cache")          # Temp/ anywhere in the path
    assert ignore("Logs/x.log")
    assert ignore("MyGame.csproj")
    assert ignore("Assets/Scripts/Player.csproj")    # glob on basename
    assert ignore("sysinfo.txt")
    assert ignore(".vs/slnx.sqlite")
    assert not ignore("Assets/Models/door.fbx")
    assert not ignore("Assets/Scenes/Main.unity")
    assert not ignore("LibraryManager/keep.cs")      # 'Library' substring, not a segment


def test_meta_path_helpers():
    assert unity.get_unity_meta_path("Assets/Models/door.fbx") == "Assets/Models/door.fbx.meta"
    assert unity.get_unity_asset_path_from_meta("Assets/Models/door.fbx.meta") == "Assets/Models/door.fbx"
    assert unity.get_unity_asset_path_from_meta("Assets/Models/door.fbx") is None
    assert unity.is_meta_path("a/b.png.meta")
    assert not unity.is_meta_path("a/b.png")


def test_find_same_basename_dependencies():
    paths = [
        "Assets/Models/door.fbx",
        "Assets/Models/door.fbx.meta",
        "Assets/Models/door.prefab",
        "Assets/Models/door.prefab.meta",
        "Assets/Models/door.mat",
        "Assets/Models/door_normal.png",
        "Assets/Models/door_albedo.png",
        "Assets/Models/window.fbx",            # different basename
        "Assets/Other/door.png",               # different directory
    ]
    deps = unity.find_same_basename_dependencies("Assets/Models/door.fbx", paths)
    assert "Assets/Models/door.fbx.meta" in deps
    assert "Assets/Models/door.prefab" in deps
    assert "Assets/Models/door.mat" in deps
    assert "Assets/Models/door_normal.png" in deps
    assert "Assets/Models/door_albedo.png" in deps
    assert "Assets/Models/door.fbx" not in deps           # excludes self
    assert "Assets/Models/window.fbx" not in deps         # different base
    assert "Assets/Other/door.png" not in deps            # different dir


def test_scan_unity_guids():
    content = """
    --- !u!1 &123
    m_Material: {fileID: 2100000, guid: 0123456789abcdef0123456789abcdef, type: 2}
    m_Mesh: {fileID: 4300000, guid: FEDCBA9876543210FEDCBA9876543210, type: 3}
    no_guid_here: 42
    """
    guids = unity.scan_unity_guids(content)
    assert "0123456789abcdef0123456789abcdef" in guids
    assert "fedcba9876543210fedcba9876543210" in guids   # lowercased
    assert len(guids) == 2
    assert unity.scan_unity_guids("") == set()


def test_find_assets_by_unity_guids():
    meta_map = {
        "0123456789abcdef0123456789abcdef": "Assets/Textures/wall_albedo.png.meta",
        "fedcba9876543210fedcba9876543210": "Assets/Materials/wall.mat.meta",
    }
    assets = unity.find_assets_by_unity_guids(
        {"0123456789ABCDEF0123456789ABCDEF", "deadbeef" * 4}, meta_map)
    assert assets == ["Assets/Textures/wall_albedo.png"]   # unknown guid ignored, case-insensitive


def test_build_lock_suggestion():
    paths = {
        "Assets/Models/door.fbx",
        "Assets/Models/door.fbx.meta",
        "Assets/Models/door.prefab",
        "Assets/Models/door.prefab.meta",
        "Assets/Models/door.mat",
        "Assets/Models/door_albedo.png",
        "Assets/Models/door_albedo.png.meta",
    }
    sug = unity.build_lock_suggestion("Assets/Models/door.fbx", paths,
                                      referenced={"Assets/Models/door_albedo.png"})
    by_path = {s["path"]: s["checked"] for s in sug}
    assert "Assets/Models/door.fbx" not in by_path                 # not itself
    assert by_path["Assets/Models/door.fbx.meta"] is True          # own meta checked
    assert by_path["Assets/Models/door.prefab"] is True            # prefab checked
    assert by_path["Assets/Models/door.mat"] is True               # material checked
    assert by_path["Assets/Models/door_albedo.png"] is True        # referenced → checked
    assert by_path["Assets/Models/door.prefab.meta"] is True       # meta of related → checked


def test_build_lock_suggestion_texture_unchecked_by_default():
    paths = {
        "Assets/Art/hero.png",
        "Assets/Art/hero.png.meta",
        "Assets/Art/hero_normal.png",
    }
    sug = unity.build_lock_suggestion("Assets/Art/hero.png", paths)
    by_path = {s["path"]: s["checked"] for s in sug}
    assert by_path["Assets/Art/hero.png.meta"] is True
    assert by_path["Assets/Art/hero_normal.png"] is False          # texture, not referenced


def test_validate_unity_push_safety():
    known = {
        "Assets/Models/wall_door.fbx", "Assets/Models/wall_door.fbx.meta",
        "Assets/Models/floor.fbx", "Assets/Models/floor.fbx.meta",
    }
    # asset changed without its meta
    w = unity.validate_unity_push_safety({"Assets/Models/wall_door.fbx"}, known)
    assert any(x["type"] == "asset_without_meta" and "wall_door.fbx.meta" in x["message"] for x in w)
    # meta changed without its asset
    w = unity.validate_unity_push_safety({"Assets/Models/wall_door.fbx.meta"}, known)
    assert any(x["type"] == "meta_without_asset" for x in w)
    # both together → no warning
    w = unity.validate_unity_push_safety(
        {"Assets/Models/wall_door.fbx", "Assets/Models/wall_door.fbx.meta"}, known)
    assert w == []


# ── Edge cases flagged in the audit ──────────────────────────────────

def test_meta_pairing_multi_dot_and_nested():
    # Multiple dots in the filename
    assert unity.get_unity_meta_path("Assets/Models/door.v2.fbx") == "Assets/Models/door.v2.fbx.meta"
    assert unity.get_unity_asset_path_from_meta("Assets/Models/door.v2.fbx.meta") == "Assets/Models/door.v2.fbx"
    # Deeply nested folders
    assert unity.get_unity_meta_path("Assets/A/B/C/D/door.fbx") == "Assets/A/B/C/D/door.fbx.meta"
    assert unity.get_unity_asset_path_from_meta("Assets/A/B/C/D/door.fbx.meta") == "Assets/A/B/C/D/door.fbx"
    # Spaces in folder names
    assert unity.get_unity_meta_path("Assets/My Folder/door.fbx") == "Assets/My Folder/door.fbx.meta"


def test_same_basename_includes_own_meta_multidot():
    paths = ["Assets/Models/door.v2.fbx", "Assets/Models/door.v2.fbx.meta"]
    deps = unity.find_same_basename_dependencies("Assets/Models/door.v2.fbx", paths)
    assert "Assets/Models/door.v2.fbx.meta" in deps


def test_same_basename_in_spaced_folder():
    paths = [
        "Assets/My Folder/door.fbx",
        "Assets/My Folder/door.fbx.meta",
        "Assets/My Folder/door.prefab",
    ]
    deps = unity.find_same_basename_dependencies("Assets/My Folder/door.fbx", paths)
    assert "Assets/My Folder/door.fbx.meta" in deps
    assert "Assets/My Folder/door.prefab" in deps


def test_should_ignore_windows_separators_and_deep_nesting():
    # Backslash paths must be normalized before matching
    assert unity.should_ignore_unity_path("Assets\\Models\\Library\\cache.bin")
    assert unity.should_ignore_unity_path("Library\\x")
    # Ignored folder nested deeply
    assert unity.should_ignore_unity_path("Assets/A/B/C/Temp/d/e/file.bin")
    assert unity.should_ignore_unity_path("a/b/c/d/e/f/g/Obj/x")
    # 'Library' as a substring of a real folder must NOT be ignored
    assert not unity.should_ignore_unity_path("Assets/LibraryUtils/keep.cs")


def test_is_unity_project_separators_and_case():
    # Unix
    assert unity.is_unity_project(["Assets/x.cs", "ProjectSettings/y.asset"])
    # Windows separators
    assert unity.is_unity_project(["Assets\\x.cs", "ProjectSettings\\y.asset"])
    # Case-insensitive (Windows filesystems)
    assert unity.is_unity_project(["assets/x", "projectsettings/y"])
    assert unity.is_unity_project(["ASSETS/x", "PROJECTSETTINGS/y"])
    # Still must not false-positive on a prefix
    assert not unity.is_unity_project(["Assetsfoo/x", "ProjectSettingsBar/y"])


def test_first_unity_guid_is_assets_own():
    # A model .meta carries its own guid first, then references others (materials).
    meta = """fileFormatVersion: 2
guid: 1111111111111111111111111111aaaa
ModelImporter:
  materials:
    - {fileID: 2100000, guid: 2222222222222222222222222222bbbb, type: 2}
"""
    assert unity.first_unity_guid(meta) == "1111111111111111111111111111aaaa"
    assert unity.first_unity_guid("no guid here") is None


def _run():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ok   {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return failed == 0


if __name__ == "__main__":
    import sys
    sys.exit(0 if _run() else 1)
