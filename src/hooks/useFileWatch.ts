import { useState, useEffect, useCallback, useRef } from 'react'
import type { CompareResult, CompareManifestEntry, CompareTombstone, SyncResult } from '../types'
import type { CrowSyncClient } from '../api/client'
import { getLocalPath, joinLocal } from '../utils/localPath'
import { getSyncState, setSyncBase, removeSyncBase } from '../utils/syncState'
import { newUploadId, getPendingUpload, setPendingUpload, clearPendingUpload } from '../utils/uploadState'
import { isNativeAvailable, scanDir, nativeUpload, nativeDownload, nativeDeleteLocal } from '../utils/nativeFs'
import { resolveScanPatterns } from '../utils/scanPatterns'

const DEFAULT_POLL_INTERVAL = 5000

/**
 * Client-side sync orchestration for the distributed model.
 *
 * The server never reads the member's disk. Instead this hook:
 *   compare() — scans the local folder natively (Rust), posts a manifest, gets a diff
 *   push()    — uploads new/modified local files via the native streaming transfer
 *   pull()    — downloads server-only files straight to the local folder
 *
 * In browser dev mode (no Tauri) native scan is unavailable, so `native` is false
 * and the hook stays idle — the UI degrades to read-only.
 */
export function useFileWatch(
  client: CrowSyncClient | null,
  projectId: number | null,
  serverUrl: string,
  memberName: string,
  apiKey: string,
  enabled: boolean = true,
  syncInterval: number = DEFAULT_POLL_INTERVAL,
) {
  const [comparison, setComparison] = useState<CompareResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastScan, setLastScan] = useState<Date | null>(null)
  const [isUnity, setIsUnity] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Guards against overlapping scans: a poll tick (every 5s) must not kick off a new
  // native MD5 scan while the previous one is still running. On a large project a scan
  // can take far longer than the poll interval, and stacking concurrent scans of the
  // same GB folder thrashes the disk so nothing ever finishes.
  const runningRef = useRef(false)
  const native = isNativeAvailable()

  const compare = useCallback(async () => {
    if (!client || !projectId) {
      setComparison(null)
      return
    }
    const localPath = getLocalPath(projectId)
    if (!native || !localPath) {
      // No way to scan a local folder (browser mode, or path not mapped yet).
      setComparison(null)
      return
    }
    // Skip this tick if a scan is already in flight — don't stack concurrent scans.
    if (runningRef.current) return
    runningRef.current = true
    setLoading(true)
    try {
      // Unity projects get extra ignore rules (Library/, *.csproj…) applied to the scan.
      const { patterns, isUnity: unity } = await resolveScanPatterns(client, localPath)
      setIsUnity(unity)
      const scanned = await scanDir(localPath, patterns)
      // Attach each file's sync base so the server can attribute mismatches (K1).
      const base = getSyncState(projectId)
      const manifest: CompareManifestEntry[] = scanned.map(f => ({
        ...f,
        base_version: base[f.path]?.version ?? 0,
        base_checksum: base[f.path]?.checksum ?? '',
      }))
      // Tombstones: paths we have a base for but no longer scanned → locally deleted.
      // Lets the server propagate the delete instead of resurrecting the file (D1).
      const scannedPaths = new Set(scanned.map(f => f.path))
      const tombstones: CompareTombstone[] = Object.entries(base)
        .filter(([p]) => !scannedPaths.has(p))
        .map(([p, b]) => ({ path: p, base_version: b.version, base_checksum: b.checksum }))
      const result = await client.compareProject(projectId, manifest, tombstones)
      setComparison(result)
      setLastScan(new Date())
    } catch {
      // scan failed / server unreachable — leave previous comparison untouched
    } finally {
      runningRef.current = false
      setLoading(false)
    }
  }, [client, projectId, native])

  // Auto-poll when enabled
  useEffect(() => {
    if (!enabled || !client || !projectId || !native) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }
    compare()
    if (syncInterval > 0) {
      intervalRef.current = setInterval(compare, syncInterval)
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [enabled, compare, client, projectId, native, syncInterval])

  const push = useCallback(async (): Promise<SyncResult | null> => {
    if (!client || !projectId || !comparison) return null
    const localPath = getLocalPath(projectId)
    if (!localPath) return null
    setLoading(true)
    const errors: SyncResult['errors'] = []
    let done = 0
    try {
      // New files push from base 0; modified files declare their last-synced
      // version as the base so the server's stale-base 409 fires if a teammate
      // moved it meanwhile. Conflict files are excluded — they need a manual
      // force-resolve, not a silent overwrite (K1).
      const queue = [
        ...comparison.new_local.map(f => ({ path: f.path, base: 0 })),
        ...comparison.modified_local.map(f => ({ path: f.path, base: f.server_version })),
      ]
      for (const item of queue) {
        try {
          // Reuse a persisted id if a previous attempt was interrupted (resume),
          // else mint one and persist it before transferring so a crash mid-upload
          // can pick up where it left off.
          const resumeId = getPendingUpload(projectId, item.path) ?? newUploadId()
          setPendingUpload(projectId, item.path, resumeId)
          const outcome = await nativeUpload({
            serverUrl, memberName, apiKey, projectId,
            relPath: item.path, absPath: joinLocal(localPath, item.path),
            baseVersion: item.base, message: '', force: false, resumeId,
          })
          if (outcome.ok) {
            done++
            clearPendingUpload(projectId, item.path)
            // Record the new server version as this path's sync base.
            const v = outcome.body?.current_version
            const c = outcome.body?.checksum
            if (typeof v === 'number' && typeof c === 'string') {
              setSyncBase(projectId, item.path, v, c)
            }
          } else {
            // Definitive server response (lock/conflict/too-large) — the session is
            // gone or invalid, so drop the resume id. (Network failures fall to the
            // catch below, which keeps it so the next push resumes.)
            clearPendingUpload(projectId, item.path)
            const detail = outcome.body?.detail ?? outcome.body
            if (outcome.status === 423) {
              errors.push({ path: item.path, error: `Locked by ${detail?.locked_by || 'another member'}` })
            } else if (outcome.status === 409) {
              errors.push({ path: item.path, error: `Conflict — server has v${detail?.server_version ?? '?'}` })
            } else {
              errors.push({ path: item.path, error: typeof detail === 'string' ? detail : `HTTP ${outcome.status}` })
            }
          }
        } catch (e) {
          errors.push({ path: item.path, error: e instanceof Error ? e.message : String(e) })
        }
      }
      // Propagate local deletes to the server (file we had synced, now gone locally,
      // server still has it unchanged) so it doesn't reappear on the next pull (D1).
      for (const d of comparison.deleted_local) {
        try {
          await client.deleteFile(projectId, d.path)
          removeSyncBase(projectId, d.path)
          done++
        } catch (e) {
          errors.push({ path: d.path, error: e instanceof Error ? e.message : String(e) })
        }
      }
      await compare()
      return { done, errors }
    } finally {
      setLoading(false)
    }
  }, [client, projectId, comparison, serverUrl, memberName, apiKey, compare])

  const pull = useCallback(async (): Promise<SyncResult | null> => {
    if (!client || !projectId || !comparison) return null
    const localPath = getLocalPath(projectId)
    if (!localPath) return null
    setLoading(true)
    const errors: SyncResult['errors'] = []
    let done = 0
    const pulled: Array<{ path: string; pre_version: number; new_version: number }> = []
    try {
      // Pull server-only files AND files where only the server moved (behind).
      const queue = [...comparison.new_remote, ...comparison.behind]
      for (const f of queue) {
        try {
          // Record the pre-pull version so we can create a revertable session.
          const preVersion = getSyncState(projectId)[f.path]?.version ?? 0
          const outcome = await nativeDownload({
            serverUrl, memberName, apiKey, projectId,
            relPath: f.path, destAbsPath: joinLocal(localPath, f.path),
          })
          if (outcome.ok) {
            done++
            // The local copy now matches this server version — record it as base.
            setSyncBase(projectId, f.path, f.server_version, f.server_checksum)
            pulled.push({ path: f.path, pre_version: preVersion, new_version: f.server_version })
          } else {
            errors.push({ path: f.path, error: `HTTP ${outcome.status}` })
          }
        } catch (e) {
          errors.push({ path: f.path, error: e instanceof Error ? e.message : String(e) })
        }
      }
      // Apply remote deletes locally (server dropped a file we still have unchanged)
      // so our leftover copy doesn't re-push as new_local (D1). Native-only.
      if (native) {
        for (const d of comparison.deleted_remote) {
          try {
            await nativeDeleteLocal(joinLocal(localPath, d.path))
            removeSyncBase(projectId, d.path)
            done++
          } catch (e) {
            errors.push({ path: d.path, error: e instanceof Error ? e.message : String(e) })
          }
        }
      }
      // Log the pull session so the user can revert it later.
      if (pulled.length > 0) {
        try {
          await client.logPullSession(projectId, pulled)
        } catch {
          // Non-fatal: session logging failure should not abort a successful pull.
        }
      }
      await compare()
      return { done, errors }
    } finally {
      setLoading(false)
    }
  }, [client, projectId, comparison, serverUrl, memberName, apiKey, native, compare])

  const hasLocalChanges = comparison
    ? (comparison.summary.new_local > 0 || comparison.summary.modified_local > 0 || comparison.summary.deleted_local > 0)
    : false

  const hasRemoteChanges = comparison
    ? (comparison.summary.new_remote > 0 || comparison.summary.behind > 0 || comparison.summary.deleted_remote > 0)
    : false

  return {
    comparison,
    loading,
    lastScan,
    native,
    isUnity,
    hasLocalChanges,
    hasRemoteChanges,
    compare,
    push,
    pull,
  }
}
