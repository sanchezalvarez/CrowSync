export interface Project {
  id: number
  name: string
  description: string
  color: string
  root_path: string
  created_at: string
  file_count?: number
}

/** Loosely-typed JSON body returned by API responses/errors. Known fields are
 *  typed so reads stay safe; the index signature permits other keys without
 *  resorting to `any`. */
export interface ApiBody {
  detail?: ApiBody
  message?: string
  current_version?: number
  checksum?: string
  server_version?: number
  server_author?: string
  locked_by?: string
  [key: string]: unknown
}

/** Error thrown by the API client, carrying the HTTP status and parsed body so
 *  callers can branch on 409/423 and surface server detail. */
export interface ApiError extends Error {
  status?: number
  body?: ApiBody
}

/** One file in a client-supplied local-folder manifest (see Rust `scan_dir`). */
export interface ManifestEntry {
  path: string
  checksum: string
  size_bytes: number
}

/** Manifest entry sent to `/compare`: the scanned file plus the client's sync
 * base for that path, so the server can attribute checksum mismatches (K1). */
export interface CompareManifestEntry extends ManifestEntry {
  base_version: number
  base_checksum: string
}

/** A path the client had synced (has a base for) but no longer has on disk —
 * sent to `/compare` so a local delete propagates instead of resurrecting (D1). */
export interface CompareTombstone {
  path: string
  base_version: number
  base_checksum: string
}

export interface Member {
  id: number
  name: string
  email: string
  avatar_color: string
  api_key?: string
  is_active: number
  created_at: string
}

export interface FileEntry {
  id: number
  project_id: number
  path: string
  current_version: number
  size_bytes: number
  checksum: string
  locked_by_id: number | null
  locked_by: { id: number; name: string } | null
  locked_at: string | null
  lock_reason?: string
  lock_group_id?: string | null
  last_synced_at: string | null
  created_at: string
}

export interface Version {
  id: number
  file_id: number
  version: number
  size_bytes: number
  checksum: string
  author_id: number | null
  author_name?: string
  message: string
  storage_filename: string
  created_at: string
}

export interface Activity {
  id: number
  project_id: number
  member_id: number | null
  member_name?: string
  file_id: number | null
  action: string
  file_path: string
  version: number | null
  detail: string
  created_at: string
}

export interface SyncEvent {
  event: string
  data: {
    path?: string
    version?: number
    member?: string
    [key: string]: unknown
  }
  at: string
}

export const FILE_STATUS = {
  synced:    { icon: '\u2705', color: '#0B7268', label: 'In sync' },
  modified:  { icon: '\u2B06', color: '#E04E0E', label: 'Modified locally' },
  behind:    { icon: '\u2B07', color: '#1A6BAA', label: 'Server has newer version' },
  locked:    { icon: '\uD83D\uDD12', color: '#C8902A', label: 'Locked by someone' },
  locked_me: { icon: '\uD83D\uDD11', color: '#5C3A9C', label: 'Locked by you' },
  untracked: { icon: '\u2753', color: '#9A8E7E', label: 'Not on server yet' },
  conflict:  { icon: '\u26A0\uFE0F', color: '#A32D2D', label: 'Conflict detected' },
} as const

export type FileStatusType = keyof typeof FILE_STATUS

/** Both-exist mismatch entry (local changed, server changed, or both). */
export interface CompareChangedEntry {
  path: string
  local_checksum: string
  local_size: number
  server_checksum: string
  server_version: number
}

/** Server-only / behind entry the client can pull and then record as its base. */
export interface CompareRemoteEntry {
  path: string
  server_version: number
  server_checksum: string
  size_bytes: number
}

/** Non-blocking Unity asset/.meta out-of-sync warning from /compare. */
export interface UnityWarning {
  type: 'asset_without_meta' | 'meta_without_asset'
  path: string
  message: string
}

export interface CompareResult {
  new_local: Array<{ path: string; size_bytes: number; checksum: string }>
  modified_local: CompareChangedEntry[]  // local changed, server unchanged → push
  behind: CompareRemoteEntry[]           // server changed, local unchanged → pull
  conflict: CompareChangedEntry[]        // both changed (or no base) → manual resolve
  new_remote: CompareRemoteEntry[]       // server-only → pull
  synced: Array<{ path: string; version: number }>
  deleted_local: Array<{ path: string }>   // client deleted it, server unchanged → delete on server (push)
  deleted_remote: Array<{ path: string }>  // server deleted it, local unchanged → delete locally (pull)
  unity?: { is_unity: boolean; warnings: UnityWarning[] }
  summary: {
    new_local: number; modified_local: number; behind: number; conflict: number
    new_remote: number; synced: number; deleted_local: number; deleted_remote: number
    total_local: number; total_server: number
  }
}

/** One related-file suggestion from /files/lock-suggestions. */
export interface LockSuggestion {
  path: string
  checked: boolean
  locked_by: string | null   // set if already locked by another member
}

export interface LockSuggestionResult {
  path: string
  is_meta: boolean
  suggestions: LockSuggestion[]
}

/** Response from /files/lock — primary file plus any auto/also-locked companions. */
export interface LockResult {
  file: FileEntry
  locked: string[]
  auto_meta: string | null
  also_locked: string[]
  skipped: Array<{ path: string; locked_by: string }>
  group_id: string | null
}

export interface ServerSettings {
  storage_root: string
  auto_unlock_hours: string
  server_version: string
  max_file_size_mb: string
}

/** Aggregated, read-only project metrics from GET /projects/{id}/stats. */
export interface ProjectStats {
  storage: {
    file_count: number
    files_bytes: number      // sum of current files' sizes
    version_count: number
    version_bytes: number    // sum of every version blob (full history on disk)
    total_bytes: number      // files_bytes + version_bytes
  }
  locks: {
    total: number
    by_member: Array<{ member_id: number; member_name: string; avatar_color: string; count: number }>
  }
  contributors: Array<{ member_id: number; member_name: string; avatar_color: string; actions: number }>
  file_types: Array<{ ext: string; count: number; bytes: number }>
  heatmap: Array<{ day: string; count: number }>  // {YYYY-MM-DD, count} for days with activity
}

/** Outcome of a client-orchestrated push or pull (per-file upload/download loop). */
export interface SyncResult {
  done: number
  errors: Array<{ path: string; error: string }>
}

export interface PullSessionFile {
  file_path: string
  pre_version: number
  new_version: number
}

export interface PullSession {
  id: number
  project_id: number
  member_id: number
  member_name: string
  file_count: number
  files: PullSessionFile[]
  created_at: string
}

export interface PullRevertResult {
  reverted: string[]
  skipped: Array<{ path: string; reason: string }>
  errors: Array<{ path: string; error: string }>
}
