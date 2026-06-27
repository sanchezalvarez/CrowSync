import { useState, useCallback, useEffect, useMemo } from 'react'
import type { FileEntry, Activity, ApiError, PullSession } from '../types'
import type { CrowSyncClient } from '../api/client'
import { setSyncBase, removeSyncBase } from '../utils/syncState'
import { getLocalPath, joinLocal } from '../utils/localPath'
import { isNativeAvailable, nativeDeleteLocal } from '../utils/nativeFs'
import { useProjects } from '../hooks/useProjects'
import { useFiles } from '../hooks/useFiles'
import { useFileWatch } from '../hooks/useFileWatch'
import { useCrowSyncWebSocket } from '../hooks/useWebSocket'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { useToast } from '../hooks/useToast'
import { SyncStatus } from '../components/CrowSync/SyncStatus'
import { ProjectPanel } from '../components/CrowSync/ProjectPanel'
import { FileTree } from '../components/CrowSync/FileTree'
import { FileDetail } from '../components/CrowSync/FileDetail'
import { ActivityFeed } from '../components/CrowSync/ActivityFeed'
import { ConflictDialog } from '../components/CrowSync/ConflictDialog'
import { LockDialog, type LockDialogData } from '../components/CrowSync/LockDialog'
import { UnlockGroupDialog } from '../components/CrowSync/UnlockGroupDialog'
import { InitProjectDialog } from '../components/CrowSync/InitProjectDialog'
import { StatsDialog } from '../components/CrowSync/StatsDialog'
import { ProjectMembersDialog } from '../components/CrowSync/ProjectMembersDialog'
import { ToastContainer } from '../components/CrowSync/ToastContainer'

interface SyncPageProps {
  client: CrowSyncClient
  serverUrl: string
  memberName: string
  apiKey: string
  currentMemberId: number | null
  syncInterval: number
  onSettings: () => void
}

interface ConflictInfo {
  path: string
  serverVersion: number
  serverAuthor: string
  message: string
  pendingFile?: File
}

export function SyncPage({ client, serverUrl, memberName, apiKey, currentMemberId, syncInterval, onSettings }: SyncPageProps) {
  const { projects, selectedId, select, createProject, deleteProject } = useProjects(client)
  const { ws, events } = useCrowSyncWebSocket(serverUrl, selectedId, memberName, apiKey)
  const {
    files, refresh,
    uploadFile, lockFile, unlockFile, revertFile, downloadFile, deleteFile,
  } = useFiles(client, selectedId, ws)
  const { isOnline, serverVersion } = useSyncStatus(client)
  const {
    comparison, hasLocalChanges, hasRemoteChanges, native, isUnity,
    push, pull, compare,
  } = useFileWatch(client, selectedId, serverUrl, memberName, apiKey, isOnline, syncInterval)

  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null)
  const [activities, setActivities] = useState<Activity[]>([])
  const [pullSessions, setPullSessions] = useState<PullSession[]>([])
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)
  const [lockDialog, setLockDialog] = useState<LockDialogData | null>(null)
  const [unlockDialog, setUnlockDialog] = useState<{ path: string; count: number } | null>(null)
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [showInit, setShowInit] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [showProjects, setShowProjects] = useState(true)
  const [showActivity, setShowActivity] = useState(true)
  const { toasts, addToast, removeToast } = useToast()

  // Load activities when project changes
  useEffect(() => {
    if (!selectedId) {
      setActivities([])
      return
    }
    client.listActivity(selectedId).then(setActivities).catch(() => {})
  }, [client, selectedId, files])

  // Load pull sessions when project changes
  useEffect(() => {
    if (!selectedId) { setPullSessions([]); return }
    client.getPullSessions(selectedId).then(setPullSessions).catch(() => {})
  }, [client, selectedId, files])

  // Update selected file when files change
  useEffect(() => {
    if (selectedFile) {
      const updated = files.find(f => f.path === selectedFile.path)
      if (updated) setSelectedFile(updated)
    }
  }, [files])

  const handleUpload = useCallback(async (path: string, file: File) => {
    const existing = files.find(f => f.path === path)
    const baseVersion = existing?.current_version || 0
    try {
      const result = await uploadFile(path, file, baseVersion)
      // Keep the sync base current so a later local edit isn't misread as a
      // conflict against a stale base (K1).
      if (result && selectedId) setSyncBase(selectedId, path, result.current_version, result.checksum)
    } catch (err) {
      const e = err as ApiError
      if (e.status === 409 && e.body) {
        setConflict({
          path,
          serverVersion: e.body.server_version ?? 0,
          serverAuthor: e.body.server_author ?? '',
          message: e.body.message || '',
          pendingFile: file,
        })
      } else if (e.status === 423) {
        addToast(`File is locked by ${e.body?.locked_by || 'another user'}`)
      } else {
        addToast(`Upload failed: ${e.message}`)
      }
    }
  }, [files, uploadFile])

  const handleDownload = useCallback(async (path: string, version?: number) => {
    try {
      const blob = await downloadFile(path, version)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = path.split('/').pop() || 'file'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      addToast(`Download failed: ${(err as ApiError).message}`)
    }
  }, [downloadFile])

  const handleLock = useCallback(async (path: string) => {
    if (!selectedId) return
    try {
      // Discover related Unity files (meta, prefab/mat, GUID refs) before locking.
      const res = await client.lockSuggestions(selectedId, path)
      setLockDialog({ path, isMeta: res.is_meta, suggestions: res.suggestions })
    } catch {
      // Suggestions are best-effort — fall back to a plain lock dialog.
      setLockDialog({ path, isMeta: path.endsWith('.meta'), suggestions: [] })
    }
  }, [client, selectedId])

  const handleConfirmLock = useCallback(async (reason: string, selected: string[]) => {
    if (!lockDialog) return
    const path = lockDialog.path
    setLockDialog(null)
    try {
      const result = await lockFile(path, reason, selected)
      if (result?.auto_meta) {
        addToast(`Also locked related Unity meta file: ${result.auto_meta.split('/').pop()}`)
      }
      const extras = (result?.also_locked || []).filter(p => p !== result?.auto_meta)
      if (extras.length > 0) addToast(`Locked ${extras.length} related file${extras.length > 1 ? 's' : ''}`)
      if (result?.skipped?.length) {
        addToast(`Skipped (locked by others): ${result.skipped.map(s => s.path.split('/').pop()).join(', ')}`)
      }
    } catch (err) {
      const e = err as ApiError
      if (e.status === 423) addToast(`File is locked by ${e.body?.locked_by || 'another member'}`)
      else addToast(e.message)
    }
  }, [lockDialog, lockFile, addToast])

  const doUnlock = useCallback(async (path: string, scope: 'file' | 'group') => {
    try { await unlockFile(path, scope) } catch (err) { addToast((err as ApiError).message) }
  }, [unlockFile, addToast])

  const handleUnlock = useCallback(async (path: string) => {
    const f = files.find(x => x.path === path)
    const groupId = f?.lock_group_id
    const groupSize = groupId ? files.filter(x => x.lock_group_id === groupId).length : 1
    // Only ask when the file is genuinely part of a multi-file lock group.
    if (groupId && groupSize > 1) {
      setUnlockDialog({ path, count: groupSize })
    } else {
      await doUnlock(path, 'file')
    }
  }, [files, doUnlock])

  const handleRevert = useCallback(async (path: string, version: number) => {
    if (!confirm(`Revert ${path} to version ${version}?`)) return
    try { await revertFile(path, version) } catch (err) { addToast((err as ApiError).message) }
  }, [revertFile])

  const handleDelete = useCallback(async (path: string) => {
    // Unity safety: warn when deleting one half of an asset/.meta pair.
    let extra = ''
    if (path.endsWith('.meta')) {
      const asset = path.slice(0, -'.meta'.length)
      if (files.some(f => f.path === asset)) extra = `\n\nWarning: the asset ${asset.split('/').pop()} will remain without its .meta file.`
    } else if (files.some(f => f.path === `${path}.meta`)) {
      extra = `\n\nWarning: ${path.split('/').pop()}.meta will remain without its asset. Consider deleting both.`
    }
    if (!confirm(`Delete ${path}? This cannot be undone.${extra}`)) return
    try {
      await deleteFile(path)
      if (selectedId) {
        removeSyncBase(selectedId, path)
        // Also remove the local copy, else it re-pushes as new_local on the next
        // sync (single-user resurrection — D1). Best-effort; native-only.
        const localPath = getLocalPath(selectedId)
        if (isNativeAvailable() && localPath) {
          try { await nativeDeleteLocal(joinLocal(localPath, path)) } catch { /* leftover local file, non-fatal */ }
        }
      }
    } catch (err) { addToast((err as ApiError).message) }
  }, [deleteFile, files, selectedId])

  const handlePush = useCallback(async () => {
    setPushing(true)
    try {
      const result = await push()
      if (result) {
        await refresh()
        if (result.errors.length > 0) {
          addToast(`Pushed ${result.done} files, ${result.errors.length} errors`)
        }
      }
    } catch (err) {
      addToast(`Push failed: ${(err as ApiError).message}`)
    } finally {
      setPushing(false)
    }
  }, [push, refresh])

  const handlePull = useCallback(async () => {
    setPulling(true)
    try {
      const result = await pull()
      if (result) {
        await refresh()
        if (result.errors.length > 0) {
          addToast(`Pulled ${result.done} files, ${result.errors.length} errors`)
        }
      }
    } catch (err) {
      addToast(`Pull failed: ${(err as ApiError).message}`)
    } finally {
      setPulling(false)
    }
  }, [pull, refresh])

  const handleRevertPullSession = useCallback(async (sessionId: number) => {
    if (!selectedId) return
    try {
      const result = await client.revertPullSession(selectedId, sessionId)
      await refresh()
      const msg = result.errors.length > 0
        ? `Reverted ${result.reverted.length} files, ${result.errors.length} errors`
        : `Reverted ${result.reverted.length} files`
      addToast(msg)
    } catch (err) {
      addToast(`Revert failed: ${(err as ApiError).message}`)
    }
  }, [client, selectedId, refresh, addToast])

  const handleForceUpload = useCallback(async () => {
    if (!conflict?.pendingFile) return
    try {
      const existing = files.find(f => f.path === conflict.path)
      const result = await uploadFile(conflict.path, conflict.pendingFile, existing?.current_version || 0, '', true)
      if (result && selectedId) setSyncBase(selectedId, conflict.path, result.current_version, result.checksum)
      setConflict(null)
    } catch (err) {
      addToast(`Force upload failed: ${(err as ApiError).message}`)
    }
  }, [conflict, files, uploadFile])

  // Change summary for status bar
  const changeSummary = comparison?.summary

  // Non-blocking safety warnings shown above the file area before a push:
  //  - any project: a locally-changed file that's locked by another member
  //  - Unity only: asset/.meta out of sync (server) + scene/prefab edited without a lock
  const safetyWarnings = useMemo(() => {
    if (!comparison) return [] as string[]
    const msgs: string[] = []
    const byPath = new Map(files.map(f => [f.path, f]))
    const changed = [
      ...comparison.new_local.map(f => f.path),
      ...comparison.modified_local.map(f => f.path),
    ]

    // Pushing a file someone else locked may overwrite their work.
    for (const p of changed) {
      const f = byPath.get(p)
      if (f && f.locked_by_id && f.locked_by_id !== currentMemberId) {
        msgs.push(`${p.split('/').pop()} is locked by ${f.locked_by?.name || 'another member'}. Pushing may overwrite their work.`)
      }
    }

    if (comparison.unity?.is_unity) {
      msgs.push(...comparison.unity.warnings.map(w => w.message))
      const lockedByMe = new Set(files.filter(f => f.locked_by_id === currentMemberId).map(f => f.path))
      // Only genuine modifications warrant a "modified without a lock" warning. A
      // new_local file (e.g. the whole initial import) is brand new — it isn't on
      // the server, can't conflict with anyone, and wasn't "modified". Warning on
      // it spams the bar with thousands of false positives during import.
      for (const p of comparison.modified_local.map(f => f.path)) {
        if (lockedByMe.has(p)) continue
        const name = p.split('/').pop()
        if (p.endsWith('.unity')) msgs.push(`Scene ${name} was modified without a lock. Scenes are high-conflict files.`)
        else if (p.endsWith('.prefab')) msgs.push(`Prefab ${name} was modified without a lock.`)
      }
    }
    return msgs
  }, [comparison, files, currentMemberId])

  return (
    <div className="flex flex-col h-full bg-surface-0 text-text-primary scanlines">
      {/* Topbar */}
      <header className="h-11 bg-surface-1 border-b border-border-active flex items-center px-4 gap-3 shrink-0" style={{ boxShadow: '0 1px 0 var(--color-border-active)' }}>
        {/* Left: project context */}
        <div className="flex-1 flex items-center gap-3 min-w-0">
          {selectedId && (
            <span className="text-text-muted text-xs font-mono truncate">
              / {projects.find(p => p.id === selectedId)?.name}
            </span>
          )}

          {selectedId && isUnity && (
          <span
            className="text-[11px] font-mono text-sync bg-sync-muted border border-sync/30 px-1.5 py-px rounded"
            title="Assets/ and ProjectSettings/ detected — Unity ignore rules active"
          >
            Unity project detected
          </span>
        )}

        </div>

        {/* Center: sync status + actions */}
        <div className="flex items-center gap-3 shrink-0">
          {selectedId && changeSummary && (
          <div className="flex gap-3 text-[13px] font-mono">
            {changeSummary.synced > 0 && (
              <span className="text-sync">{changeSummary.synced} synced</span>
            )}
            {changeSummary.new_local > 0 && (
              <span className="text-accent">+{changeSummary.new_local} new</span>
            )}
            {changeSummary.modified_local > 0 && (
              <span className="text-accent">{changeSummary.modified_local} mod</span>
            )}
            {changeSummary.behind > 0 && (
              <span className="text-pull">{changeSummary.behind} behind</span>
            )}
            {changeSummary.new_remote > 0 && (
              <span className="text-pull">{changeSummary.new_remote} remote</span>
            )}
            {changeSummary.conflict > 0 && (
              <span className="text-danger">{changeSummary.conflict} conflict</span>
            )}
          </div>
        )}

        {selectedId && (
          <div className="flex gap-1.5">
            <button
              onClick={handlePush}
              disabled={!isOnline || pushing || !hasLocalChanges}
              className={`btn-riso text-[13px] font-mono font-bold px-2.5 py-1 rounded ${
                hasLocalChanges
                  ? 'btn-riso-primary'
                  : 'btn-riso-secondary'
              }`}
            >
              {pushing ? 'PUSH...' : `PUSH${hasLocalChanges ? ` ${(changeSummary?.new_local || 0) + (changeSummary?.modified_local || 0)}` : ''}`}
            </button>

            <button
              onClick={handlePull}
              disabled={!isOnline || pulling || !hasRemoteChanges}
              className={`btn-riso text-[13px] font-mono font-bold px-2.5 py-1 rounded ${
                hasRemoteChanges
                  ? 'btn-riso-pull'
                  : 'btn-riso-secondary'
              }`}
            >
              {pulling ? 'PULL...' : `PULL${hasRemoteChanges ? ` ${(changeSummary?.new_remote || 0) + (changeSummary?.behind || 0)}` : ''}`}
            </button>

            {/* Only offer INIT until this member has mapped a local folder. Once
                initialized, re-running it would re-upload every file at base 0
                (a wall of 409s) — the normal PUSH/PULL flow takes over instead. */}
            {getLocalPath(selectedId) === '' && (
              <button
                onClick={() => setShowInit(true)}
                disabled={!isOnline || !native}
                className="btn-riso btn-riso-secondary text-[13px] font-mono px-2 py-1 rounded"
                title={native ? 'Initialize / import folder' : 'Local sync needs the desktop app'}
              >
                INIT
              </button>
            )}
          </div>
          )}
        </div>

        {/* Right: connection + member + settings */}
        <div className="flex-1 flex items-center justify-end gap-3 min-w-0">
          <SyncStatus isOnline={isOnline} serverVersion={serverVersion} />

          <span className="text-[13px] text-text-muted font-mono truncate">{memberName}</span>

          {selectedId && (
            <button
              onClick={() => setShowMembers(true)}
              className="btn-riso btn-riso-secondary text-[12px] font-mono font-bold tracking-wider px-2 h-7 rounded shrink-0"
              title="Project members"
            >
              MEMBERS
            </button>
          )}

          {selectedId && (
            <button
              onClick={() => setShowStats(true)}
              className="btn-riso btn-riso-secondary text-[12px] font-mono font-bold tracking-wider px-2 h-7 rounded shrink-0"
              title="Project stats"
            >
              STATS
            </button>
          )}

          <button
            onClick={onSettings}
            className="btn-riso btn-riso-secondary text-[12px] font-mono font-bold tracking-wider w-9 h-7 px-0 rounded shrink-0"
            title="Settings"
          >
            CFG
          </button>
        </div>
      </header>

      {/* Safety warnings — non-blocking */}
      {selectedId && safetyWarnings.length > 0 && (
        <div className="shrink-0 bg-locked-muted/40 border-b border-locked/30 px-4 py-1.5 max-h-24 overflow-y-auto">
          {safetyWarnings.map((w, i) => (
            <div key={i} className="flex items-center gap-2 text-[12px] text-locked">
              <span className="shrink-0">{'⚠️'}</span>
              <span className="truncate" title={w}>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {showProjects ? (
          <ProjectPanel
            projects={projects}
            selectedId={selectedId}
            onSelect={select}
            onCreate={createProject}
            onDelete={deleteProject}
            onCollapse={() => setShowProjects(false)}
          />
        ) : (
          // Collapsed: a thin rail at the edge re-opens the panel (the toggle lives
          // on/at the panel itself, not in the header).
          <button
            onClick={() => setShowProjects(true)}
            title="Show projects"
            className="w-5 shrink-0 bg-surface-1 border-r border-border-active flex items-start justify-center pt-2.5 text-text-muted hover:text-accent hover:bg-surface-2 transition-colors font-mono text-sm"
          >
            {'›'}
          </button>
        )}

        {selectedId ? (
          files.length === 0 && !comparison ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-4 animate-riso-fade-up">
                <div className="w-12 h-12 mx-auto rounded-lg bg-surface-2 border border-border-active flex items-center justify-center text-xl text-text-ghost"
                  style={{ boxShadow: 'var(--shadow-riso-sm-teal)' }}>
                  {'\uD83D\uDCC2'}
                </div>
                <div>
                  <p className="text-sm text-text-primary font-medium tracking-wide">Empty project</p>
                  <p className="text-xs text-text-muted mt-1">Import a folder to start tracking</p>
                </div>
                <button
                  onClick={() => setShowInit(true)}
                  disabled={!isOnline || !native}
                  className="btn-riso btn-riso-primary text-xs font-bold px-5 py-2 rounded"
                >
                  Initialize Project
                </button>
                {!native && (
                  <p className="text-[12px] text-text-ghost mt-2">Local sync requires the desktop app</p>
                )}
              </div>
            </div>
          ) : (
            <>
              <FileTree
                files={files}
                comparison={comparison}
                selectedPath={selectedFile?.path ?? null}
                onSelectFile={setSelectedFile}
                onUpload={handleUpload}
                onLock={handleLock}
                onUnlock={handleUnlock}
                onDownload={handleDownload}
                onDelete={handleDelete}
                currentMemberId={currentMemberId}
                isOnline={isOnline}
              />
              {selectedFile && (
                <FileDetail
                  file={selectedFile}
                  files={files}
                  currentMemberId={currentMemberId}
                  isOnline={isOnline}
                  client={client}
                  projectId={selectedId}
                  onUpload={handleUpload}
                  onDownload={handleDownload}
                  onLock={handleLock}
                  onUnlock={handleUnlock}
                  onRevert={handleRevert}
                  onSelectFile={setSelectedFile}
                />
              )}
            </>
          )
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-text-ghost font-mono tracking-widest uppercase">Select a project</p>
          </div>
        )}

        {/* Activity log — right column */}
        {showActivity ? (
          <ActivityFeed
            activities={activities}
            events={events}
            pullSessions={pullSessions}
            onRevertPullSession={handleRevertPullSession}
            onCollapse={() => setShowActivity(false)}
          />
        ) : (
          <button
            onClick={() => setShowActivity(true)}
            title="Show log"
            className="w-5 shrink-0 bg-surface-1 border-l border-border-active flex items-start justify-center pt-2.5 text-text-muted hover:text-accent hover:bg-surface-2 transition-colors font-mono text-sm"
          >
            {'‹'}
          </button>
        )}
      </div>

      {/* Init project dialog */}
      {selectedId && projects.find(p => p.id === selectedId) && (
        <InitProjectDialog
          project={projects.find(p => p.id === selectedId)!}
          client={client}
          isOpen={showInit}
          onClose={() => setShowInit(false)}
          onComplete={() => { refresh(); compare() }}
        />
      )}

      {/* Project stats overlay */}
      {showStats && selectedId && (
        <StatsDialog client={client} projectId={selectedId} onClose={() => setShowStats(false)} />
      )}

      {/* Project members overlay */}
      {showMembers && selectedId && projects.find(p => p.id === selectedId) && (
        <ProjectMembersDialog
          client={client}
          project={projects.find(p => p.id === selectedId)!}
          currentMemberId={currentMemberId}
          onClose={() => setShowMembers(false)}
        />
      )}

      {/* Toasts */}
      <ToastContainer toasts={toasts} onRemove={removeToast} />

      {/* Conflict dialog */}
      <ConflictDialog
        conflict={conflict}
        onCancel={() => setConflict(null)}
        onDownloadTheirs={() => {
          if (conflict) handleDownload(conflict.path)
          setConflict(null)
        }}
        onForceUpload={handleForceUpload}
      />

      {/* Lock dialog — reason + Unity dependency suggestions */}
      <LockDialog
        data={lockDialog}
        onCancel={() => setLockDialog(null)}
        onConfirm={handleConfirmLock}
      />

      {/* Unlock group dialog — single file vs whole group */}
      <UnlockGroupDialog
        data={unlockDialog}
        onCancel={() => setUnlockDialog(null)}
        onUnlock={(scope) => { if (unlockDialog) doUnlock(unlockDialog.path, scope); setUnlockDialog(null) }}
      />
    </div>
  )
}
