"""Unity-aware helpers for CrowSync: project detection, ignore rules, .meta pairing
and lightweight dependency discovery.

These are deliberately small, pure functions operating on path strings and file
content (no disk / DB access) so they're easy to test and reuse. The server feeds
them the tracked file list (paths) and blob content; the client mirrors only the
ignore matching for its native scan.

This is NOT a Unity importer — GUID handling is a best-effort regex scan, enough to
suggest related files to lock together, not to resolve a full dependency graph.
"""

import re

# Paths to skip in a detected Unity project (generated / machine-local / IDE junk).
# Directory rules end with "/" and match any path segment; the rest match a file's
# basename (glob). Mirrors the matching in file_manager.is_ignored / fs_ops.rs.
UNITY_IGNORE_PATTERNS = [
    "Library/", "Temp/", "Obj/", "Logs/", "UserSettings/",
    "MemoryCaptures/", "Builds/", "Build/",
    ".vs/", ".idea/", ".gradle/",
    "*.csproj", "*.sln", "*.user", "*.pidb", "*.booproj", "*.svd",
    "*.pdb", "*.mdb",
    "sysinfo.txt", "crashlytics-build.properties",
]

# Text-based Unity assets worth scanning for GUID references.
UNITY_TEXT_ASSET_EXTS = (".prefab", ".mat", ".unity", ".asset")

_GUID_RE = re.compile(r"guid:\s*([0-9a-fA-F]{32})")


def is_unity_project(paths) -> bool:
    """True if the file set looks like a Unity project: has both an Assets/ and a
    ProjectSettings/ folder. Tolerant of backslash separators and folder-name case
    (Windows filesystems report the on-disk case, which is usually exact, but be safe)."""
    has_assets = False
    has_settings = False
    for p in paths:
        top = p.replace("\\", "/").lstrip("/").split("/", 1)[0].lower()
        if top == "assets":
            has_assets = True
        elif top == "projectsettings":
            has_settings = True
        if has_assets and has_settings:
            return True
    return False


def _glob_to_regex(pattern: str) -> str:
    # Minimal glob: * matches anything but '/'. Enough for the patterns above.
    out = ["^"]
    for ch in pattern:
        if ch == "*":
            out.append("[^/]*")
        else:
            out.append(re.escape(ch))
    out.append("$")
    return "".join(out)


def should_ignore_unity_path(rel_path: str) -> bool:
    """Whether a forward-slash relative path matches a Unity ignore rule."""
    rel = rel_path.replace("\\", "/").strip("/")
    if not rel:
        return False
    segments = rel.split("/")
    basename = segments[-1]
    for pattern in UNITY_IGNORE_PATTERNS:
        if pattern.endswith("/"):
            directory = pattern[:-1]
            if any(seg == directory for seg in segments):
                return True
        else:
            rx = _glob_to_regex(pattern)
            if re.match(rx, basename) or re.match(rx, rel):
                return True
    return False


def is_meta_path(path: str) -> bool:
    return path.endswith(".meta")


def get_unity_meta_path(asset_path: str) -> str:
    """The .meta sidecar path for an asset (Assets/door.fbx -> Assets/door.fbx.meta)."""
    return asset_path + ".meta"


def get_unity_asset_path_from_meta(meta_path: str):
    """The asset a .meta belongs to (Assets/door.fbx.meta -> Assets/door.fbx), or
    None if not a .meta path."""
    if meta_path.endswith(".meta"):
        return meta_path[:-len(".meta")]
    return None


def _dirname(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def _basename(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def _asset_stem(filename: str) -> str:
    """Leading name component before the first dot: 'door.fbx' -> 'door',
    'door.fbx.meta' -> 'door', 'door_normal.png' -> 'door_normal'."""
    return filename.split(".", 1)[0]


def find_same_basename_dependencies(file_path: str, all_paths) -> list:
    """Files in the same directory that share the asset's base name — its .meta,
    a same-named .prefab/.mat/.png, and `<base>_suffix` texture variants
    (door_normal.png, door_albedo.png, ...). Returns sorted paths, excluding
    file_path itself."""
    directory = _dirname(file_path)
    base = _asset_stem(_basename(file_path))
    if not base:
        return []
    out = []
    for cand in all_paths:
        if cand == file_path or _dirname(cand) != directory:
            continue
        cand_stem = _asset_stem(_basename(cand))
        if cand_stem == base or cand_stem.startswith(base + "_"):
            out.append(cand)
    return sorted(out)


def scan_unity_guids(content: str) -> set:
    """All 32-hex GUID references in a text Unity file (prefab/mat/scene/asset)."""
    return set(m.lower() for m in _GUID_RE.findall(content or ""))


def first_unity_guid(content: str):
    """The first GUID in document order — for a .meta this is the asset's *own* guid
    (the top-level `guid:` field), not any later reference (e.g. a model importer's
    material remaps). Returns None if there is none."""
    m = _GUID_RE.search(content or "")
    return m.group(1).lower() if m else None


def find_assets_by_unity_guids(guids, meta_guid_map: dict) -> list:
    """Map referenced GUIDs to asset paths via a {guid: meta_path} index built from
    the project's .meta files. Returns sorted asset paths (meta path minus .meta)."""
    out = []
    for guid in guids:
        meta_path = meta_guid_map.get(guid.lower())
        if not meta_path:
            continue
        asset = get_unity_asset_path_from_meta(meta_path)
        if asset:
            out.append(asset)
    return sorted(set(out))


def _ext_of_asset(path: str) -> str:
    """Extension of the underlying asset, ignoring a trailing .meta:
    'door.prefab' -> 'prefab', 'door.prefab.meta' -> 'prefab'."""
    p = path[:-len(".meta")] if path.endswith(".meta") else path
    return p.rsplit(".", 1)[-1].lower() if "." in _basename(p) else ""


# Extensions checked by default in the dependency dialog (besides .meta files).
_DEFAULT_CHECKED_EXTS = {"prefab", "mat"}


def build_lock_suggestion(file_path: str, all_paths, referenced=None) -> list:
    """Ordered list of related files to offer when locking `file_path`:
      {path, checked} where `checked` is the dialog's default.

    Defaults checked: the asset's .meta, same-basename .prefab/.mat, and any assets
    referenced by GUID (plus their .meta). Default unchecked: textures and other
    same-basename files unless directly referenced. Only paths that exist in
    `all_paths` are returned."""
    all_set = set(all_paths)
    referenced = set(referenced or [])
    suggestions = []
    seen = set()

    def add(path: str, checked: bool):
        if path == file_path or path in seen or path not in all_set:
            return
        seen.add(path)
        suggestions.append({"path": path, "checked": checked})

    # 1. The asset's own .meta — always suggested, checked.
    add(get_unity_meta_path(file_path), True)

    # 2. Same-basename neighbours.
    for dep in find_same_basename_dependencies(file_path, all_set):
        ext = _ext_of_asset(dep)
        checked = is_meta_path(dep) or ext in _DEFAULT_CHECKED_EXTS or dep in referenced
        add(dep, checked)

    # 3. GUID-referenced assets and their metas — checked.
    for ref in sorted(referenced):
        add(ref, True)
        add(get_unity_meta_path(ref), True)

    return suggestions


def validate_unity_push_safety(changed_paths, all_paths) -> list:
    """Warn when an asset/.meta pair is out of sync in a push: an asset is changing
    without its .meta coming along, or a .meta without its asset. Non-blocking.

    `changed_paths` = paths the client intends to push; `all_paths` = every path the
    project knows about (so we only warn about pairs that actually exist)."""
    changed = set(changed_paths)
    known = set(all_paths)
    warnings = []
    for path in sorted(changed):
        if is_meta_path(path):
            asset = get_unity_asset_path_from_meta(path)
            if asset and asset in known and asset not in changed:
                warnings.append({
                    "type": "meta_without_asset",
                    "path": path,
                    "message": f"{path} changed without {asset}",
                })
        else:
            meta = get_unity_meta_path(path)
            if meta in known and meta not in changed:
                warnings.append({
                    "type": "asset_without_meta",
                    "path": path,
                    "message": f"{path} changed without {meta}",
                })
    return warnings
