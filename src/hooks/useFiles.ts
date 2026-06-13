import { useState, useEffect, useCallback, useRef } from 'react'
import type { FileEntry, SyncEvent } from '../types'
import type { CrowSyncClient } from '../api/client'
import type { CrowSyncWebSocket } from '../api/websocket'

export function useFiles(
  client: CrowSyncClient | null,
  projectId: number | null,
  ws: CrowSyncWebSocket | null,
) {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    if (!client || !projectId) {
      setFiles([])
      return
    }
    setLoading(true)
    try {
      const list = await client.listFiles(projectId)
      setFiles(list)
    } catch {
      // offline
    } finally {
      setLoading(false)
    }
  }, [client, projectId])

  useEffect(() => { refresh() }, [refresh])

  // Listen for WebSocket events — debounced refresh
  useEffect(() => {
    if (!ws) return
    const unsub = ws.onAny((_event: SyncEvent) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => refresh(), 500)
    })
    return () => {
      unsub()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [ws, refresh])

  const uploadFile = useCallback(async (
    path: string, file: File | Blob, baseVersion = 0, message = '', force = false,
  ) => {
    if (!client || !projectId) return
    const result = await client.uploadFile(projectId, path, file, baseVersion, message, force)
    await refresh()
    return result
  }, [client, projectId, refresh])

  const lockFile = useCallback(async (path: string, reason = '', also: string[] = []) => {
    if (!client || !projectId) return
    const result = await client.lockFile(projectId, path, reason, also)
    await refresh()
    return result
  }, [client, projectId, refresh])

  const unlockFile = useCallback(async (path: string, scope: 'file' | 'group' = 'file') => {
    if (!client || !projectId) return
    const result = await client.unlockFile(projectId, path, scope)
    await refresh()
    return result
  }, [client, projectId, refresh])

  const revertFile = useCallback(async (path: string, version: number) => {
    if (!client || !projectId) return
    const result = await client.revertFile(projectId, path, version)
    await refresh()
    return result
  }, [client, projectId, refresh])

  const downloadFile = useCallback(async (path: string, version?: number) => {
    if (!client || !projectId) return
    return client.downloadFile(projectId, path, version)
  }, [client, projectId])

  const deleteFile = useCallback(async (path: string) => {
    if (!client || !projectId) return
    await client.deleteFile(projectId, path)
    await refresh()
  }, [client, projectId, refresh])

  return {
    files, loading, refresh,
    uploadFile, lockFile, unlockFile, revertFile, downloadFile, deleteFile,
  }
}
