import { useState, useEffect } from 'react'
import type { FileEntry, Version } from '../../types'
import { FILE_STATUS } from '../../types'
import type { CrowSyncClient } from '../../api/client'

interface FileDetailProps {
  file: FileEntry | null
  files: FileEntry[]
  currentMemberId: number | null
  isOnline: boolean
  client: CrowSyncClient | null
  projectId: number | null
  onUpload: (path: string, file: File) => void
  onDownload: (path: string, version?: number) => void
  onLock: (path: string) => void
  onUnlock: (path: string) => void
  onRevert: (path: string, version: number) => void
  onSelectFile: (file: FileEntry) => void
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function FileDetail({
  file, files, currentMemberId, isOnline, client, projectId,
  onUpload, onDownload, onLock, onUnlock, onRevert, onSelectFile,
}: FileDetailProps) {
  const [versions, setVersions] = useState<Version[]>([])
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  useEffect(() => {
    if (!file || !client || !projectId) {
      setVersions([])
      return
    }
    client.listVersions(projectId, file.path)
      .then(setVersions)
      .catch(() => setVersions([]))
  }, [file?.path, file?.current_version, client, projectId])

  if (!file) {
    return (
      <div className="w-64 bg-surface-1 border-l border-border-active flex items-center justify-center">
        <div className="text-center text-text-ghost text-xs">
          <span className="text-xl block mb-2 opacity-20">{'\uD83D\uDCC4'}</span>
          <span className="uppercase tracking-widest text-[12px] font-mono">Select a file</span>
        </div>
      </div>
    )
  }

  const status = file.locked_by_id
    ? (file.locked_by_id === currentMemberId ? 'locked_me' : 'locked')
    : 'synced'
  const statusInfo = FILE_STATUS[status]
  const isLockedByMe = file.locked_by_id === currentMemberId
  const isLockedByOther = file.locked_by_id !== null && !isLockedByMe
  const fileName = file.path.split('/').pop() || file.path

  // Files locked together share a lock_group_id. Show them as one logical group.
  const groupMembers = file.lock_group_id
    ? files.filter(f => f.lock_group_id === file.lock_group_id)
    : []
  const isGroup = groupMembers.length > 1
  // Title = the base asset (shortest non-.meta path), falling back to this file.
  const groupTitle = isGroup
    ? ([...groupMembers].filter(f => !f.path.endsWith('.meta')).sort((a, b) => a.path.length - b.path.length)[0]?.path
        .split('/').pop() ?? fileName)
    : ''

  const withLoading = async (action: string, fn: () => Promise<void>) => {
    setActionLoading(action)
    try { await fn() } finally { setActionLoading(null) }
  }

  const handleFileUpload = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = () => {
      const f = input.files?.[0]
      if (f) withLoading('upload', () => Promise.resolve(onUpload(file.path, f)))
    }
    input.click()
  }

  return (
    <div className="w-64 bg-surface-1 border-l border-border-active flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border-active">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-sm">{statusInfo.icon}</span>
          <h3 className="text-[15px] font-semibold text-text-primary truncate tracking-wide">{fileName}</h3>
        </div>
        <p className="text-[12px] text-text-ghost font-mono truncate">{file.path}</p>
      </div>

      {/* Info */}
      <div className="px-3 py-2.5 border-b border-border space-y-1.5">
        {[
          ['Version', `v${file.current_version}`, 'text-text-primary font-mono'],
          ['Size', formatSize(file.size_bytes), ''],
          ['Status', statusInfo.label, ''],
          ...(file.locked_by ? [['Locked by', file.locked_by.name, 'text-locked']] : []),
          ...(file.locked_by && file.locked_at ? [['Locked at', formatTime(file.locked_at), '']] : []),
          ...(file.checksum ? [['MD5', file.checksum, 'text-text-ghost font-mono text-[11px]']] : []),
        ].map(([label, value, cls]) => (
          <div key={label as string} className="flex justify-between text-[13px]">
            <span className="text-text-muted font-mono tracking-widest text-[11px] uppercase">{label}</span>
            <span className={`text-text-secondary truncate max-w-28 ${cls}`}>{value}</span>
          </div>
        ))}
      </div>

      {/* Lock reason */}
      {file.locked_by && (
        <div className="px-3 py-2 border-b border-border">
          <span className="text-text-muted font-mono tracking-widest text-[11px] uppercase">Reason</span>
          <p className={`text-[13px] mt-0.5 ${file.lock_reason ? 'text-text-secondary' : 'text-text-ghost italic'}`}>
            {file.lock_reason || 'No reason given'}
          </p>
        </div>
      )}

      {/* Lock group — files locked together */}
      {isGroup && (
        <div className="px-3 py-2.5 border-b border-border">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[13px]">{'🔗'}</span>
            <span className="text-[13px] font-semibold text-text-primary truncate">{groupTitle}</span>
            <span className="text-[11px] font-mono text-text-ghost ml-auto shrink-0">{groupMembers.length} files</span>
          </div>
          <div className="space-y-0.5">
            {[...groupMembers].sort((a, b) => a.path.localeCompare(b.path)).map(m => (
              <button
                key={m.path}
                onClick={() => onSelectFile(m)}
                className={`w-full text-left flex items-center gap-1.5 text-[12px] px-1.5 py-0.5 rounded hover:bg-surface-2 ${
                  m.path === file.path ? 'text-text-primary' : 'text-text-secondary'
                }`}
                title={m.path}
              >
                <span className="text-text-ghost shrink-0">{m.path === file.path ? '▸' : '·'}</span>
                <span className="font-mono truncate">{m.path.split('/').pop()}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="px-3 py-2.5 border-b border-border space-y-2">
        <button
          onClick={handleFileUpload}
          disabled={!isOnline || isLockedByOther || !!actionLoading}
          className="btn-riso btn-riso-primary w-full text-[13px] py-1.5 rounded"
        >
          {actionLoading === 'upload' ? 'Uploading...' : 'Upload New Version'}
        </button>
        <button
          onClick={() => withLoading('download', async () => { await onDownload(file.path) })}
          disabled={!isOnline || !!actionLoading}
          className="btn-riso btn-riso-secondary w-full text-[13px] py-1.5 rounded"
        >
          {actionLoading === 'download' ? 'Downloading...' : 'Download Latest'}
        </button>
        <button
          onClick={() => withLoading('lock', async () => {
            if (file.locked_by_id) await onUnlock(file.path)
            else await onLock(file.path)
          })}
          disabled={!isOnline || isLockedByOther || !!actionLoading}
          className="btn-riso btn-riso-secondary w-full text-[13px] py-1.5 rounded"
        >
          {actionLoading === 'lock' ? 'Working...' : (file.locked_by_id ? 'Unlock' : 'Lock')}
        </button>
      </div>

      {/* Version history */}
      <div className="px-3 py-2.5 flex-1">
        <h4 className="text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">History</h4>
        {versions.length > 0 ? (
          <div className="space-y-0">
            {versions.map(v => (
              <div key={v.version} className="flex items-center justify-between text-[13px] py-1 border-b border-border">
                <div className="flex-1 min-w-0 mr-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-text-secondary font-mono shrink-0">v{v.version}</span>
                    {v.author_name && (
                      <span className="text-text-ghost truncate">{v.author_name}</span>
                    )}
                  </div>
                  {v.message && (
                    <p className="text-[11px] text-text-ghost truncate">{v.message}</p>
                  )}
                  <p className="text-[11px] text-text-ghost">{formatTime(v.created_at)}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => onDownload(file.path, v.version)}
                    disabled={!isOnline}
                    className="text-text-ghost hover:text-pull disabled:opacity-30 transition-colors"
                  >
                    {'\u2193'}
                  </button>
                  {v.version < file.current_version && (
                    <button
                      onClick={() => onRevert(file.path, v.version)}
                      disabled={!isOnline}
                      className="text-text-ghost hover:text-accent disabled:opacity-30 transition-colors"
                    >
                      {'\u21BA'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : file.current_version > 0 ? (
          <p className="text-[12px] text-text-ghost">Loading...</p>
        ) : null}
      </div>
    </div>
  )
}
