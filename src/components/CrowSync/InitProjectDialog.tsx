import { useState, useCallback } from 'react'
import { pickFolder } from '../../utils/folderPicker'
import { setLocalPath, joinLocal } from '../../utils/localPath'
import { setSyncBase } from '../../utils/syncState'
import { isNativeAvailable, scanDir, nativeUpload } from '../../utils/nativeFs'
import type { ScanProgress } from '../../utils/nativeFs'
import { resolveScanPatterns } from '../../utils/scanPatterns'
import type { CrowSyncClient } from '../../api/client'
import type { Project, ManifestEntry } from '../../types'

interface InitProjectDialogProps {
  project: Project
  client: CrowSyncClient
  isOpen: boolean
  onClose: () => void
  onComplete: () => void
}

type InitPhase = 'path' | 'scanning' | 'confirm' | 'importing' | 'done' | 'error'

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

/**
 * Client-side project init: pick the member's LOCAL folder, scan it natively
 * (Rust), then upload every file. The path is stored client-side (per member);
 * the server never reads it.
 */
export function InitProjectDialog({
  project, client, isOpen, onClose, onComplete,
}: InitProjectDialogProps) {
  const [phase, setPhase] = useState<InitPhase>('path')
  const [editPath, setEditPath] = useState('')
  const [manifest, setManifest] = useState<ManifestEntry[]>([])
  const [resultMessage, setResultMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [failedFiles, setFailedFiles] = useState<string[]>([])
  const [progress, setProgress] = useState(0)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)

  const totalSize = manifest.reduce((sum, f) => sum + f.size_bytes, 0)

  const reset = useCallback(() => {
    setPhase('path')
    setEditPath('')
    setManifest([])
    setResultMessage('')
    setErrorMessage('')
    setFailedFiles([])
    setProgress(0)
    setScanProgress(null)
  }, [])

  const handleScan = useCallback(async () => {
    const path = editPath.trim()
    if (!path) return
    if (!isNativeAvailable()) {
      setErrorMessage('Local scan needs the desktop app (browser mode is read-only).')
      setPhase('error')
      return
    }
    setLocalPath(project.id, path)
    setScanProgress(null)
    setPhase('scanning')
    try {
      // Resolve ignore patterns (incl. Unity Library/, *.csproj…) via the shared
      // helper so the import scan stays in sync with the background poll's scan.
      const { patterns } = await resolveScanPatterns(client, path)
      const found = await scanDir(path, patterns, p => setScanProgress(p))
      setManifest(found)
      setPhase('confirm')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [client, project.id, editPath])

  const handleImport = useCallback(async () => {
    setPhase('importing')
    setProgress(0)
    const errors: string[] = []
    let done = 0
    for (const f of manifest) {
      try {
        const outcome = await nativeUpload({
          serverUrl: client.serverUrl, memberName: client.member, apiKey: client.key,
          projectId: project.id, relPath: f.path, absPath: joinLocal(editPath.trim(), f.path),
          baseVersion: 0, message: 'Initial import', force: false,
        })
        if (outcome.ok) {
          done++
          // Record the imported version as the sync base so future compares can
          // attribute changes correctly (K1).
          const v = outcome.body?.current_version
          if (typeof v === 'number') setSyncBase(project.id, f.path, v, f.checksum)
        } else {
          const detail = outcome.body?.detail ?? outcome.body
          errors.push(`${f.path}: ${typeof detail === 'string' ? detail : `HTTP ${outcome.status}`}`)
        }
      } catch (err) {
        errors.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`)
      }
      setProgress(p => p + 1)
    }
    setResultMessage(
      `Imported ${done} files` + (errors.length > 0 ? `, ${errors.length} errors` : '')
    )
    if (errors.length > 0) setFailedFiles(errors)
    setPhase('done')
    onComplete()
  }, [client, project.id, editPath, manifest, onComplete])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="card-riso rounded-lg w-[480px] overflow-hidden animate-riso-scale-in">
        {/* Header */}
        <div className="relative bg-accent-muted border-b border-accent/30 px-5 py-3 overflow-hidden">
          <div className="halftone-accent absolute inset-0" />
          <h2 className="relative text-sm font-bold text-accent tracking-wide">Initialize Project</h2>
          <p className="relative text-[13px] text-text-muted">{project.name}</p>
        </div>

        <div className="px-5 py-4">
          {phase === 'path' && (
            <div className="space-y-3">
              <p className="text-[15px] text-text-secondary">
                Pick your local project folder. It will be scanned and all files uploaded.
              </p>
              <div>
                <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1">Local folder</label>
                <div className="flex gap-1.5">
                  <input
                    type="text" value={editPath} onChange={e => setEditPath(e.target.value)}
                    placeholder="D:\GameDev\MyProject"
                    className="input-riso flex-1 rounded px-3 py-1.5 text-[14px] text-text-primary font-mono placeholder-text-ghost"
                    autoFocus
                  />
                  <button type="button"
                    onClick={async () => { const p = await pickFolder('Select project folder'); if (p) setEditPath(p) }}
                    className="btn-riso btn-riso-secondary text-[14px] px-3 rounded shrink-0"
                  >
                    Browse
                  </button>
                </div>
              </div>
            </div>
          )}

          {phase === 'scanning' && (
            <div className="py-8 text-center">
              <div className="animate-spin text-xl inline-block text-accent">{'↻'}</div>
              <p className="text-[14px] text-text-secondary mt-2 font-mono">
                Scanning folder... {scanProgress ? `${scanProgress.scanned} files` : ''}
              </p>
              {scanProgress?.current && (
                <p className="text-[12px] text-text-ghost mt-1 font-mono truncate px-4">
                  {scanProgress.current}
                </p>
              )}
            </div>
          )}

          {phase === 'confirm' && (
            <div className="space-y-3">
              <div className="bg-surface-0 rounded border border-border-active p-3"
                style={{ boxShadow: 'var(--shadow-riso-sm-teal)' }}>
                <p className="text-[13px] text-text-muted font-mono truncate mb-2">{editPath}</p>
                <div className="flex gap-6">
                  <div>
                    <div className="text-lg font-bold text-sync font-mono">{manifest.length}</div>
                    <div className="text-[12px] text-text-muted uppercase tracking-widest font-mono">files</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-pull font-mono">{formatSize(totalSize)}</div>
                    <div className="text-[12px] text-text-muted uppercase tracking-widest font-mono">total</div>
                  </div>
                </div>
              </div>
              {manifest.length > 0 && (
                <div className="bg-surface-0 rounded border border-border p-2 max-h-36 overflow-y-auto text-[13px] font-mono text-text-muted space-y-px">
                  {manifest.slice(0, 15).map((f, i) => (
                    <div key={i} className="flex justify-between">
                      <span className="truncate flex-1 text-text-secondary">{f.path}</span>
                      <span className="text-text-ghost ml-2 shrink-0">{formatSize(f.size_bytes)}</span>
                    </div>
                  ))}
                  {manifest.length > 15 && (
                    <div className="text-text-ghost">+ {manifest.length - 15} more</div>
                  )}
                </div>
              )}
            </div>
          )}

          {phase === 'importing' && (
            <div className="py-8 text-center">
              <div className="animate-spin text-xl inline-block text-accent">{'↻'}</div>
              <p className="text-[14px] text-text-secondary mt-2 font-mono">Uploading {progress}/{manifest.length}...</p>
            </div>
          )}

          {phase === 'done' && (
            <div className="py-6 text-center animate-riso-fade-up">
              <span className="text-2xl block mb-2">{failedFiles.length === 0 ? '✅' : '⚠️'}</span>
              <p className={`text-[15px] font-bold tracking-wide ${failedFiles.length === 0 ? 'text-sync' : 'text-accent'}`}>
                {resultMessage}
              </p>
              {failedFiles.length > 0 && (
                <div className="mt-3 bg-danger-muted rounded border border-danger/30 p-2 max-h-24 overflow-y-auto text-left">
                  {failedFiles.map((f, i) => <p key={i} className="text-[12px] text-danger truncate font-mono">{f}</p>)}
                </div>
              )}
            </div>
          )}

          {phase === 'error' && (
            <div className="py-6 text-center animate-riso-fade-up">
              <p className="text-[15px] text-danger font-bold tracking-wide">{errorMessage}</p>
              <p className="text-[13px] text-text-muted mt-1">Check the folder path and try again.</p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex gap-2">
          {phase === 'path' && (
            <>
              <button onClick={() => { reset(); onClose() }}
                className="btn-riso btn-riso-secondary flex-1 text-[14px] py-2 rounded">Cancel</button>
              <button onClick={handleScan} disabled={!editPath.trim()}
                className="btn-riso btn-riso-primary flex-1 text-[14px] py-2 rounded">Scan</button>
            </>
          )}
          {phase === 'confirm' && (
            <>
              <button onClick={() => setPhase('path')}
                className="btn-riso btn-riso-secondary flex-1 text-[14px] py-2 rounded">Back</button>
              <button onClick={handleImport} disabled={manifest.length === 0}
                className="btn-riso btn-riso-primary flex-1 text-[14px] py-2 rounded">
                Import {manifest.length} files
              </button>
            </>
          )}
          {(phase === 'done' || phase === 'error') && (
            <button onClick={() => { reset(); onClose() }}
              className="btn-riso btn-riso-primary flex-1 text-[14px] py-2 rounded">
              {phase === 'done' ? 'Done' : 'Close'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
