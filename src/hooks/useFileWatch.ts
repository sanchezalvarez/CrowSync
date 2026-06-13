import { useState, useEffect, useCallback, useRef } from 'react'
import type { CompareResult, CompareManifestEntry, SyncResult } from '../types'
import type { CrowSyncClient } from '../api/client'
import { getLocalPath, joinLocal } from '../utils/localPath'
import { getSyncState, setSyncBase } from '../utils/syncState'
import { newUploadId, getPendingUpload, setPendingUpload, clearPendingUpload } from '../utils/uploadState'
import { isNativeAvailable, scanDir, nativeUpload, nativeDownload, detectUnity } from '../utils/nativeFs'

const POLL_INTERVAL = 5000 // 5 seconds

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
) {
  const [comparison, setComparison] = useState<CompareResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastScan, setLastScan] = useState<Date | null>(null)
  const [isUnity, setIsUnity] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const ignoreRef = useRef<string[] | null>(null)
  const unityIgnoreRef = useRef<string[] | null>(null)
  const native = isNativeAvailable()

  const getIgnore = useCallback(async () => {
    if (ignoreRef.current) return ignoreRef.current
    try {
      const patterns = await client!.getIgnorePatterns()
      ignoreRef.current = patterns
      return patterns
    } catch {
      return []
    }
  }, [client])

  const getUnityIgnore = useCallback(async () => {
    if (unityIgnoreRef.current) return unityIgnoreRef.current
    try {
      const patterns = await client!.getUnityIgnorePatterns()
      unityIgnoreRef.current = patterns
      return patterns
    } catch {
      return []
    }
  }, [client])

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
    setLoading(true)
    try {
      // Unity projects get extra ignore rules (Library/, *.csproj…) applied to the scan.
      const unity = await detectUnity(localPath)
      setIsUnity(unity)
      let patterns = await getIgnore()
      if (unity) patterns = [...patterns, ...await getUnityIgnore()]
      const scanned = await scanDir(localPath, patterns)
      // Attach each file's sync base so the server can attribute mismatches (K1).
      const base = getSyncState(projectId)
      const manifest: CompareManifestEntry[] = scanned.map(f => ({
        ...f,
        base_version: base[f.path]?.version ?? 0,
        base_checksum: base[f.path]?.checksum ?? '',
      }))
      const result = await client.compareProject(projectId, manifest)
      setComparison(result)
      setLastScan(new Date())
    } catch {
      // scan failed / server unreachable — leave previous comparison untouched
    } finally {
      setLoading(false)
    }
  }, [client, projectId, native, getIgnore, getUnityIgnore])

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
    intervalRef.current = setInterval(compare, POLL_INTERVAL)
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [enabled, compare, client, projectId, native])

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
        } catch (e: any) {
          errors.push({ path: item.path, error: e.message || String(e) })
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
    try {
      // Pull server-only files AND files where only the server moved (behind).
      const queue = [...comparison.new_remote, ...comparison.behind]
      for (const f of queue) {
        try {
          const outcome = await nativeDownload({
            serverUrl, memberName, apiKey, projectId,
            relPath: f.path, destAbsPath: joinLocal(localPath, f.path),
          })
          if (outcome.ok) {
            done++
            // The local copy now matches this server version — record it as base.
            setSyncBase(projectId, f.path, f.server_version, f.server_checksum)
          } else {
            errors.push({ path: f.path, error: `HTTP ${outcome.status}` })
          }
        } catch (e: any) {
          errors.push({ path: f.path, error: e.message || String(e) })
        }
      }
      await compare()
      return { done, errors }
    } finally {
      setLoading(false)
    }
  }, [client, projectId, comparison, serverUrl, memberName, apiKey, compare])

  const hasLocalChanges = comparison
    ? (comparison.summary.new_local > 0 || comparison.summary.modified_local > 0)
    : false

  const hasRemoteChanges = comparison
    ? (comparison.summary.new_remote > 0 || comparison.summary.behind > 0)
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
