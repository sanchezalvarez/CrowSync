import { useState, useEffect } from 'react'
import type { LockSuggestion } from '../../types'

export interface LockDialogData {
  path: string
  isMeta: boolean
  suggestions: LockSuggestion[]
}

interface LockDialogProps {
  data: LockDialogData | null
  onCancel: () => void
  /** Lock `path` plus the checked suggestion paths, with the given reason. */
  onConfirm: (reason: string, selected: string[]) => void
}

const REASON_PLACEHOLDERS = [
  'Fixing pivot and collider',
  'Updating mesh export',
  'Editing prefab layout',
]

function fileName(path: string): string {
  return path.split('/').pop() || path
}

export function LockDialog({ data, onCancel, onConfirm }: LockDialogProps) {
  const [reason, setReason] = useState('')
  const [checked, setChecked] = useState<Record<string, boolean>>({})

  // Seed checkbox state from the server's defaults whenever a new file is opened.
  // Reset form state whenever a different file is opened — the standard
  // reset-on-prop-change pattern; the extra render is intentional and bounded.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!data) return
    setReason('')
    const init: Record<string, boolean> = {}
    for (const s of data.suggestions) init[s.path] = s.checked && !s.locked_by
    setChecked(init)
  }, [data])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!data) return null

  const placeholder = REASON_PLACEHOLDERS[data.path.length % REASON_PLACEHOLDERS.length]
  const selected = data.suggestions.filter(s => checked[s.path]).map(s => s.path)

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="card-riso rounded-lg w-[440px] overflow-hidden animate-riso-scale-in">
        <div className="relative bg-locked-muted border-b border-locked/30 px-5 py-3 overflow-hidden">
          <h2 className="relative text-sm font-bold text-locked tracking-wide">
            {data.suggestions.length > 0 ? 'Lock related Unity files?' : 'Lock file'}
          </h2>
        </div>

        <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
          <p className="text-[14px] text-text-secondary">
            Locking <span className="font-mono text-accent font-bold">{fileName(data.path)}</span>.
            {data.suggestions.length > 0 && ' CrowSync found related Unity files that may need to be locked together.'}
          </p>

          {/* .meta-only warning (acceptance B) */}
          {data.isMeta && (
            <div className="text-[13px] text-locked bg-locked-muted/40 border-l-2 border-locked rounded px-3 py-2">
              You are locking a Unity <span className="font-mono">.meta</span> file directly. Usually you
              should lock the asset together with its <span className="font-mono">.meta</span> file.
            </div>
          )}

          {/* Reason */}
          <div>
            <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">
              Why are you locking this file?
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={placeholder}
              rows={2}
              autoFocus
              className="input-riso w-full rounded px-3 py-2 text-sm text-text-primary placeholder-text-ghost resize-none"
            />
            <p className="text-[11px] text-text-ghost mt-1">Optional, but it helps your teammates.</p>
          </div>

          {/* Dependency suggestions */}
          {data.suggestions.length > 0 && (
            <div className="space-y-1">
              {data.suggestions.map(s => (
                <label
                  key={s.path}
                  className={`flex items-center gap-2 text-[13px] px-2 py-1 rounded ${
                    s.locked_by ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-2'
                  }`}
                  title={s.locked_by ? `Locked by ${s.locked_by}` : s.path}
                >
                  <input
                    type="checkbox"
                    disabled={!!s.locked_by}
                    checked={!!checked[s.path]}
                    onChange={e => setChecked(prev => ({ ...prev, [s.path]: e.target.checked }))}
                  />
                  <span className="font-mono truncate text-text-secondary">{fileName(s.path)}</span>
                  {s.locked_by && <span className="text-[11px] text-locked ml-auto shrink-0">locked by {s.locked_by}</span>}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex gap-2">
          <button onClick={onCancel} className="btn-riso btn-riso-secondary flex-1 text-[12px] py-2 rounded">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(reason.trim(), [])}
            className="btn-riso btn-riso-secondary flex-1 text-[12px] py-2 rounded"
          >
            Lock only this file
          </button>
          <button
            onClick={() => onConfirm(reason.trim(), selected)}
            className="btn-riso btn-riso-primary flex-1 text-[12px] font-medium py-2 rounded"
          >
            {selected.length > 0 ? `Lock ${selected.length + 1} files` : 'Lock'}
          </button>
        </div>
      </div>
    </div>
  )
}
