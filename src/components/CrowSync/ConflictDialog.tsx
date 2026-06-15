interface ConflictInfo {
  path: string
  serverVersion: number
  serverAuthor: string
  message: string
}

interface ConflictDialogProps {
  conflict: ConflictInfo | null
  onCancel: () => void
  onDownloadTheirs: () => void
  onForceUpload: () => void
}

export function ConflictDialog({ conflict, onCancel, onDownloadTheirs, onForceUpload }: ConflictDialogProps) {
  if (!conflict) return null

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="card-riso rounded-lg w-[420px] overflow-hidden animate-riso-scale-in">
        {/* Header with halftone danger accent */}
        <div className="relative bg-danger-muted border-b border-danger/30 px-5 py-3 overflow-hidden">
          <div className="absolute inset-0"
            style={{
              backgroundImage: 'radial-gradient(circle, var(--color-danger) 1px, transparent 1px)',
              backgroundSize: '6px 6px',
              opacity: 0.06,
            }} />
          <h2 className="relative text-sm font-bold text-danger tracking-wide">Conflict Detected</h2>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-[15px] text-text-secondary">
            <span className="font-mono text-accent font-bold">{conflict.path}</span> was updated by{' '}
            <span className="text-text-primary font-medium">{conflict.serverAuthor}</span>{' '}
            <span className="text-text-muted">(v{conflict.serverVersion})</span> while you were editing.
          </p>
          {conflict.message && (
            <p className="text-[13px] text-text-muted bg-surface-0 rounded px-3 py-2 font-mono border-l-2 border-danger/40"
              style={{ boxShadow: '2px 2px 0px var(--color-surface-0)' }}>
              {conflict.message}
            </p>
          )}
          <p className="text-[13px] text-danger font-medium">
            Force upload will overwrite their changes.
          </p>
        </div>

        <div className="px-5 py-3 border-t border-border flex gap-2">
          <button onClick={onCancel}
            className="btn-riso btn-riso-secondary flex-1 text-[12px] py-2 rounded">
            Cancel
          </button>
          <button onClick={onDownloadTheirs}
            className="btn-riso btn-riso-pull flex-1 text-[12px] font-medium py-2 rounded">
            Download theirs
          </button>
          <button onClick={onForceUpload}
            className="btn-riso btn-riso-danger flex-1 text-[12px] font-medium py-2 rounded">
            Force upload
          </button>
        </div>
      </div>
    </div>
  )
}
