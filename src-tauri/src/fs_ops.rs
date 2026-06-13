//! Native filesystem + transfer layer for CrowSync's client-side sync.
//!
//! In the distributed model each member keeps a local working copy and the server
//! never reads their disk. These commands let the Tauri frontend:
//!   * `scan_dir`      — hash the local folder into a manifest (MD5, mirrors server scan)
//!   * `upload_file`   — stream a local file to the server's multipart upload endpoint
//!   * `download_file` — stream a server version straight to disk
//!
//! Transfers stream through chunks so multi-GB game assets never sit fully in RAM.

use std::io::{Read, SeekFrom};
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use walkdir::WalkDir;

const READ_CHUNK: usize = 8 * 1024 * 1024; // 8 MB, matches server CHUNK_SIZE
const MAX_CHUNK_RETRIES: u32 = 6; // transient network failures per upload before giving up

#[derive(Serialize)]
pub struct ManifestEntry {
    pub path: String,
    pub size_bytes: u64,
    pub checksum: String,
}

/// Result of an HTTP transfer. The frontend inspects `status` to distinguish
/// success from lock (423) / conflict (409) / too-large (413), mirroring the
/// status-based error handling in `src/api/client.ts`.
#[derive(Serialize)]
pub struct TransferOutcome {
    pub ok: bool,
    pub status: u16,
    /// Parsed JSON body on success (FileEntry) or error `detail` on failure.
    pub body: serde_json::Value,
}

fn to_rel(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Mirrors `file_manager.is_ignored`: directory patterns end with `/` and match
/// any path segment; file globs match the basename or the whole relative path.
fn is_ignored(rel_path: &str, patterns: &[String]) -> bool {
    for pattern in patterns {
        if let Some(dir) = pattern.strip_suffix('/') {
            if rel_path.split('/').any(|seg| seg == dir) {
                return true;
            }
        } else {
            let basename = rel_path.rsplit('/').next().unwrap_or(rel_path);
            if let Ok(g) = glob::Pattern::new(pattern) {
                if g.matches(basename) || g.matches(rel_path) {
                    return true;
                }
            }
        }
    }
    false
}

/// Read `.crowsyncignore` from the project root (one pattern per line, `#` comments).
fn load_ignore_file(root: &Path) -> Vec<String> {
    let mut patterns = Vec::new();
    if let Ok(text) = std::fs::read_to_string(root.join(".crowsyncignore")) {
        for line in text.lines() {
            let line = line.trim();
            if !line.is_empty() && !line.starts_with('#') {
                patterns.push(line.to_string());
            }
        }
    }
    patterns
}

fn md5_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Md5::new();
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn scan_impl(root: PathBuf, mut patterns: Vec<String>) -> Result<Vec<ManifestEntry>, String> {
    if !root.is_dir() {
        return Err(format!("Path not accessible: {}", root.display()));
    }
    patterns.extend(load_ignore_file(&root));

    let mut out = Vec::new();
    let walker = WalkDir::new(&root).into_iter().filter_entry(|e| {
        // Prune ignored directories so we never descend into Library/, Temp/, etc.
        if e.file_type().is_dir() && e.path() != root {
            let rel = format!("{}/", to_rel(e.path(), &root));
            !is_ignored(&rel, &patterns)
        } else {
            true
        }
    });

    for entry in walker {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = to_rel(entry.path(), &root);
        if is_ignored(&rel, &patterns) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        match md5_file(entry.path()) {
            Ok(checksum) => out.push(ManifestEntry { path: rel, size_bytes: size, checksum }),
            Err(_) => continue, // unreadable file (locked by editor etc.) — skip
        }
    }
    Ok(out)
}

/// Walk a local folder and return a manifest of {path, size_bytes, checksum}.
/// `ignore_patterns` should come from the server's `GET /ignore-patterns`.
#[tauri::command]
pub async fn scan_dir(root: String, ignore_patterns: Vec<String>) -> Result<Vec<ManifestEntry>, String> {
    tokio::task::spawn_blocking(move || scan_impl(PathBuf::from(root), ignore_patterns))
        .await
        .map_err(|e| e.to_string())?
}

/// Detect a Unity project: the folder has both an `Assets/` and a `ProjectSettings/`
/// directory. Used client-side to apply Unity ignore rules and show the indicator
/// before the first sync (the server can't see the member's disk).
#[tauri::command]
pub async fn detect_unity(root: String) -> bool {
    let base = PathBuf::from(root);
    base.join("Assets").is_dir() && base.join("ProjectSettings").is_dir()
}

#[derive(Deserialize)]
struct InitResponse {
    upload_id: String,
    offset: u64,
    chunk_size: usize,
}

#[derive(Deserialize)]
struct OffsetResponse {
    offset: u64,
}

/// Ask the server how many bytes it has for this session — used to resync after a
/// reconnect so we resume from the last received byte instead of restarting.
async fn fetch_offset(
    client: &reqwest::Client,
    base: &str,
    member_name: &str,
    api_key: &str,
    project_id: i64,
    upload_id: &str,
) -> Result<u64, String> {
    let url = format!("{base}/projects/{project_id}/files/upload/{upload_id}");
    let r = client
        .get(&url)
        .header("X-Member-Name", member_name)
        .header("X-Api-Key", api_key)
        .send()
        .await
        .map_err(|e| format!("status check failed: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("status check HTTP {}", r.status().as_u16()));
    }
    let parsed: OffsetResponse = r.json().await.map_err(|e| e.to_string())?;
    Ok(parsed.offset)
}

/// Resumable upload (tus-lite). Streams the file in chunks to the server's session
/// endpoints so a dropped connection resumes from the last received byte instead of
/// restarting a multi-GB transfer. The command signature is unchanged — callers
/// (`useFileWatch.push`) still get a `TransferOutcome` whose body is the committed
/// FileEntry on success, or the 423/409/413 `detail` on failure.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn upload_file(
    server_url: String,
    member_name: String,
    api_key: String,
    project_id: i64,
    rel_path: String,
    abs_path: String,
    base_version: i64,
    message: String,
    force: bool,
    resume_id: Option<String>,
) -> Result<TransferOutcome, String> {
    let base = server_url.trim_end_matches('/').to_string();
    let size = tokio::fs::metadata(&abs_path)
        .await
        .map_err(|e| format!("stat {abs_path}: {e}"))?
        .len();

    let client = reqwest::Client::new();
    let resume_id = resume_id.filter(|s| !s.is_empty());

    // 1. Resume an earlier interrupted transfer if the client persisted its id and the
    //    server still has the session; otherwise init a fresh one. init also runs the
    //    fail-fast lock (423) / conflict (409) / size (413) checks before any bytes move.
    let mut chunk_size = READ_CHUNK;
    let mut offset: u64 = 0;
    let upload_id: String;
    let mut resumed = false;

    if let Some(rid) = resume_id.as_ref() {
        if let Ok(off) = fetch_offset(&client, &base, &member_name, &api_key, project_id, rid).await {
            offset = off;
            resumed = true;
        }
    }

    if resumed {
        upload_id = resume_id.clone().unwrap();
    } else {
        let init_url = format!("{base}/projects/{project_id}/files/upload/init");
        let mut query = vec![
            ("path", rel_path.clone()),
            ("size", size.to_string()),
            ("message", message.clone()),
            ("base_version", base_version.to_string()),
            ("force", force.to_string()),
        ];
        if let Some(rid) = resume_id.as_ref() {
            query.push(("upload_id", rid.clone())); // let a future restart resume this very transfer
        }
        let resp = client
            .post(&init_url)
            .query(&query)
            .header("X-Member-Name", &member_name)
            .header("X-Api-Key", &api_key)
            .send()
            .await
            .map_err(|e| format!("upload init failed: {e}"))?;
        if !resp.status().is_success() {
            return finish(resp).await;
        }
        let init: InitResponse = resp.json().await.map_err(|e| format!("bad init response: {e}"))?;
        upload_id = init.upload_id;
        offset = init.offset;
        chunk_size = if init.chunk_size == 0 { READ_CHUNK } else { init.chunk_size };
    }

    // 2. stream chunks, resuming from the server's offset on transient failures.
    let mut file = tokio::fs::File::open(&abs_path)
        .await
        .map_err(|e| format!("open {abs_path}: {e}"))?;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
    }
    let chunk_url = format!("{base}/projects/{project_id}/files/upload/{upload_id}");
    let mut buf = vec![0u8; chunk_size];
    let mut fails: u32 = 0;

    while offset < size {
        let n = read_chunk(&mut file, &mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break; // file shorter than its declared size — let complete() report the mismatch
        }
        let res = client
            .patch(&chunk_url)
            .query(&[("offset", &offset.to_string())])
            .header("X-Member-Name", &member_name)
            .header("X-Api-Key", &api_key)
            .header("Content-Type", "application/octet-stream")
            .body(buf[..n].to_vec())
            .send()
            .await;

        match res {
            Ok(r) if r.status().is_success() => {
                let parsed: OffsetResponse =
                    r.json().await.map_err(|e| format!("bad chunk response: {e}"))?;
                offset = parsed.offset;
                fails = 0;
            }
            // 409 = offset drift (we reconnected and the server is ahead/behind).
            // Resync to the server's truth and re-read the next chunk from there.
            Ok(r) if r.status().as_u16() == 409 => {
                offset = fetch_offset(&client, &base, &member_name, &api_key, project_id, &upload_id).await?;
                file.seek(SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
                fails = 0;
            }
            // Any other status (413/404/...) is terminal — surface it to the UI.
            Ok(r) => return finish(r).await,
            Err(e) => {
                fails += 1;
                if fails > MAX_CHUNK_RETRIES {
                    return Err(format!("chunk upload failed after {MAX_CHUNK_RETRIES} retries: {e}"));
                }
                let delay = 300u64.saturating_mul(1u64 << (fails - 1).min(5));
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                // Best-effort resync; on failure keep the current offset and retry the same chunk.
                if let Ok(o) = fetch_offset(&client, &base, &member_name, &api_key, project_id, &upload_id).await {
                    offset = o;
                }
                file.seek(SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
            }
        }
    }

    // 3. complete — server verifies size, computes md5, commits the new version.
    let complete_url = format!("{base}/projects/{project_id}/files/upload/{upload_id}/complete");
    let resp = client
        .post(&complete_url)
        .header("X-Member-Name", &member_name)
        .header("X-Api-Key", &api_key)
        .send()
        .await
        .map_err(|e| format!("upload complete failed: {e}"))?;
    finish(resp).await
}

/// Read up to `buf.len()` bytes, looping over short reads. Returns bytes filled
/// (0 at EOF).
async fn read_chunk(file: &mut tokio::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

#[tauri::command]
pub async fn download_file(
    server_url: String,
    member_name: String,
    api_key: String,
    project_id: i64,
    rel_path: String,
    dest_abs_path: String,
    version: Option<i64>,
) -> Result<TransferOutcome, String> {
    let url = format!("{}/projects/{}/files/download", server_url.trim_end_matches('/'), project_id);
    let client = reqwest::Client::new();
    let mut query: Vec<(String, String)> = vec![("path".into(), rel_path.clone())];
    if let Some(v) = version {
        query.push(("version".into(), v.to_string()));
    }

    let resp = client
        .get(&url)
        .query(&query)
        .header("X-Member-Name", member_name)
        .header("X-Api-Key", api_key)
        .send()
        .await
        .map_err(|e| format!("download request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null);
        return Ok(TransferOutcome { ok: false, status: status.as_u16(), body });
    }

    // Stream to a temp file first, then rename — avoids leaving a half-written asset
    // in the working tree if the connection drops mid-download.
    let dest = PathBuf::from(&dest_abs_path);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension("crowsync-part");
    let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&tmp, &dest).await.map_err(|e| e.to_string())?;

    Ok(TransferOutcome { ok: true, status: status.as_u16(), body: serde_json::Value::Null })
}

async fn finish(resp: reqwest::Response) -> Result<TransferOutcome, String> {
    let status = resp.status();
    let body = resp.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null);
    Ok(TransferOutcome { ok: status.is_success(), status: status.as_u16(), body })
}
