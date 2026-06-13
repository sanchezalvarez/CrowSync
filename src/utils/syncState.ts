/**
 * Per-project client-side sync base.
 *
 * For each tracked path the client records the {version, checksum} it last
 * successfully synced (pushed, pulled or imported). Compare uses this base to
 * tell "I changed it locally" from "the server has a newer version" from "both
 * changed" — without it, push silently overwrites teammates and pull never
 * updates existing files (AUDIT.md K1).
 *
 * The base describes *this machine's* last sync, so it lives in localStorage
 * keyed by project id, mirroring `localPath.ts`.
 */

export interface SyncBase {
  version: number
  checksum: string
}

type SyncStateMap = Record<string, SyncBase>

const key = (projectId: number) => `crowsync_sync_state_${projectId}`

export function getSyncState(projectId: number): SyncStateMap {
  try {
    const raw = localStorage.getItem(key(projectId))
    return raw ? (JSON.parse(raw) as SyncStateMap) : {}
  } catch {
    return {}
  }
}

function writeSyncState(projectId: number, state: SyncStateMap): void {
  localStorage.setItem(key(projectId), JSON.stringify(state))
}

/** Record the last-synced version + checksum for a path (after push/pull/import). */
export function setSyncBase(projectId: number, path: string, version: number, checksum: string): void {
  const state = getSyncState(projectId)
  state[path] = { version, checksum }
  writeSyncState(projectId, state)
}

/** Forget a path's base (e.g. after a local or remote delete). */
export function removeSyncBase(projectId: number, path: string): void {
  const state = getSyncState(projectId)
  if (path in state) {
    delete state[path]
    writeSyncState(projectId, state)
  }
}

export function clearSyncState(projectId: number): void {
  localStorage.removeItem(key(projectId))
}
