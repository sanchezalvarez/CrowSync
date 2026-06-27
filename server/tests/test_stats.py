"""Tests for GET /projects/{id}/stats — aggregated project metrics."""


def _upload(client, pid, path, content, headers):
    return client.post(
        f"/projects/{pid}/files/upload",
        params={"path": path},
        files={"file": (path.split("/")[-1], content, "application/octet-stream")},
        headers=headers,
    )


def _stats(client, pid, headers):
    return client.get(f"/projects/{pid}/stats", headers=headers)


def test_stats_empty_project_is_all_zero(app_client, member, project):
    r = _stats(app_client, project["id"], member["headers"])
    assert r.status_code == 200
    body = r.json()
    assert body["storage"] == {
        "file_count": 0, "files_bytes": 0, "version_count": 0,
        "version_bytes": 0, "total_bytes": 0,
    }
    assert body["locks"] == {"total": 0, "by_member": []}
    assert body["contributors"] == []
    assert body["file_types"] == []
    assert body["heatmap"] == []


def test_stats_unknown_project_is_404(app_client, member):
    r = _stats(app_client, 9999, member["headers"])
    assert r.status_code == 404


def test_stats_requires_auth(app_client, project):
    """No credentials → rejected (422 missing required auth headers), never 200."""
    r = app_client.get(f"/projects/{project['id']}/stats")
    assert r.status_code in (401, 422)


def test_stats_storage_counts_files_and_version_history(app_client, member, project):
    pid = project["id"]
    _upload(app_client, pid, "Assets/a.fbx", b"v1", member["headers"])
    _upload(app_client, pid, "Assets/a.fbx", b"v2-bigger", member["headers"])  # 2nd version
    _upload(app_client, pid, "Assets/b.png", b"img", member["headers"])

    body = _stats(app_client, pid, member["headers"]).json()
    s = body["storage"]
    assert s["file_count"] == 2          # two distinct files
    assert s["version_count"] == 3       # a.fbx v1+v2, b.png v1
    assert s["files_bytes"] == len(b"v2-bigger") + len(b"img")
    assert s["version_bytes"] == len(b"v1") + len(b"v2-bigger") + len(b"img")
    assert s["total_bytes"] == s["files_bytes"] + s["version_bytes"]


def test_stats_active_locks_grouped_by_member(app_client, member, project):
    pid = project["id"]
    _upload(app_client, pid, "Assets/a.fbx", b"x", member["headers"])
    _upload(app_client, pid, "Assets/b.fbx", b"y", member["headers"])
    app_client.post(f"/projects/{pid}/files/lock",
                    json={"path": "Assets/a.fbx", "reason": "wip"}, headers=member["headers"])

    body = _stats(app_client, pid, member["headers"]).json()
    assert body["locks"]["total"] == 1
    assert len(body["locks"]["by_member"]) == 1
    row = body["locks"]["by_member"][0]
    assert row["member_name"] == member["name"]
    assert row["count"] == 1


def test_stats_contributors_count_uploads(app_client, member, project):
    pid = project["id"]
    _upload(app_client, pid, "Assets/a.fbx", b"x", member["headers"])
    _upload(app_client, pid, "Assets/b.fbx", b"y", member["headers"])

    body = _stats(app_client, pid, member["headers"]).json()
    assert len(body["contributors"]) == 1
    c = body["contributors"][0]
    assert c["member_name"] == member["name"]
    assert c["actions"] == 2


def test_stats_file_types_aggregated_by_extension(app_client, member, project):
    pid = project["id"]
    _upload(app_client, pid, "Assets/a.fbx", b"aaaa", member["headers"])
    _upload(app_client, pid, "Assets/b.fbx", b"bb", member["headers"])
    _upload(app_client, pid, "README", b"no-ext", member["headers"])

    body = _stats(app_client, pid, member["headers"]).json()
    types = {t["ext"]: t for t in body["file_types"]}
    assert types[".fbx"]["count"] == 2
    assert types[".fbx"]["bytes"] == len(b"aaaa") + len(b"bb")
    assert types["(none)"]["count"] == 1


def test_stats_heatmap_records_today_activity(app_client, member, project):
    pid = project["id"]
    _upload(app_client, pid, "Assets/a.fbx", b"x", member["headers"])

    body = _stats(app_client, pid, member["headers"]).json()
    assert len(body["heatmap"]) >= 1
    assert sum(d["count"] for d in body["heatmap"]) >= 1
    # Each entry is a {day, count} with an ISO date string.
    assert all("day" in d and "count" in d for d in body["heatmap"])
