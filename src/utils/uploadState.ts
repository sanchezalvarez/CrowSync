/**
 * Per-project pending resumable uploads.
 *
 * The client generates the upload id up-front and persists it here *before*
 * starting the transfer, so if the app is killed mid-upload the next push can
 * hand the same id to the native uploader, which resumes from the server's last
 * received byte instead of restarting a multi-GB transfer. The id is cleared
 * once the upload completes (or is abandoned).
 *
 * Lives in localStorage keyed by project id, mirroring `syncState.ts`.
 */

const key = (projectId: number) => `crowsync_uploads_${projectId}`

type PendingMap = Record<string, string> // path -> upload_id

function read(projectId: number): PendingMap {
  try {
    const raw = localStorage.getItem(key(projectId))
    return raw ? (JSON.parse(raw) as PendingMap) : {}
  } catch {
    return {}
  }
}

function write(projectId: number, map: PendingMap): void {
  localStorage.setItem(key(projectId), JSON.stringify(map))
}

/** A new random upload id (hex). Crypto when available, else a Math.random fallback. */
export function newUploadId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16)
    c.getRandomValues(bytes)
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  }
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')).join('')
}

/** The persisted in-flight upload id for a path, if any. */
export function getPendingUpload(projectId: number, path: string): string | null {
  return read(projectId)[path] ?? null
}

export function setPendingUpload(projectId: number, path: string, uploadId: string): void {
  const map = read(projectId)
  map[path] = uploadId
  write(projectId, map)
}

export function clearPendingUpload(projectId: number, path: string): void {
  const map = read(projectId)
  if (path in map) {
    delete map[path]
    write(projectId, map)
  }
}
