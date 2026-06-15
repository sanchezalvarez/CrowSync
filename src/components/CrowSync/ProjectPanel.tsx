import { useState } from 'react'
import type { Project } from '../../types'

interface ProjectPanelProps {
  projects: Project[]
  selectedId: number | null
  onSelect: (id: number) => void
  onCreate: (name: string, description?: string, color?: string) => Promise<unknown>
  onDelete: (id: number) => Promise<void>
}

// User-pickable project label colors. Intentionally hex literals — these are the
// chosen colors stored on the project row, not theme tokens.
const PROJECT_COLORS = ['#FF6B35', '#00D4AA', '#5B8DEF', '#F59E0B', '#EF4444', '#A78BFA']

export function ProjectPanel({ projects, selectedId, onSelect, onCreate, onDelete }: ProjectPanelProps) {
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newColor, setNewColor] = useState('#FF6B35')
  const [creating, setCreating] = useState(false)

  const resetForm = () => {
    setNewName('')
    setNewDescription('')
    setNewColor('#FF6B35')
    setShowNew(false)
  }

  const handleCreate = async () => {
    if (!newName.trim() || creating) return
    setCreating(true)
    try {
      // No path here — the local working folder is chosen per-member in Init.
      await onCreate(newName.trim(), newDescription.trim(), newColor)
      resetForm()
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="w-52 bg-surface-1 border-r border-border-active flex flex-col h-full">
      <div className="px-3 py-2.5 border-b border-border-active flex items-center justify-between">
        <span className="text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest">Projects</span>
        <button
          onClick={() => setShowNew(true)}
          title="New project"
          className="btn-riso btn-riso-secondary w-5 h-5 px-0 text-sm font-bold rounded"
        >
          +
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {projects.map(p => (
          <div
            key={p.id}
            onClick={() => onSelect(p.id)}
            onContextMenu={e => {
              e.preventDefault()
              if (confirm(`Delete project "${p.name}"?`)) onDelete(p.id)
            }}
            className={`px-3 py-2 cursor-pointer transition-all group ${
              selectedId === p.id
                ? 'bg-surface-2 border-l-2'
                : 'border-l-2 border-l-transparent hover:bg-surface-2/50'
            }`}
            style={selectedId === p.id ? { borderLeftColor: p.color } : undefined}
          >
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
              <span className="text-[15px] text-text-primary font-medium truncate">{p.name}</span>
            </div>
            {p.description && (
              <p className="text-[12px] text-text-ghost ml-4 truncate mt-0.5" title={p.description}>
                {p.description}
              </p>
            )}
            {p.file_count !== undefined && p.file_count > 0 && (
              <span className="text-[12px] text-text-muted ml-4 font-mono">{p.file_count} files</span>
            )}
          </div>
        ))}
        {projects.length === 0 && (
          <div className="px-3 py-10 text-center text-text-ghost text-xs">
            No projects yet
          </div>
        )}
      </div>

      {/* New project dialog */}
      {showNew && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => !creating && resetForm()}
        >
          <div
            className="card-riso rounded-lg w-[400px] overflow-hidden animate-riso-scale-in"
            onClick={e => e.stopPropagation()}
          >
            {/* Header with halftone accent strip */}
            <div className="relative bg-accent-muted border-b border-accent/30 px-5 py-3 overflow-hidden">
              <div className="halftone-accent absolute inset-0" />
              <h2 className="relative text-sm font-bold text-accent tracking-wide">New Project</h2>
              <p className="relative text-[13px] text-text-muted">Pick your local folder later in Init</p>
            </div>

            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') resetForm() }}
                  placeholder="My Game"
                  className="input-riso w-full rounded px-3 py-2 text-sm text-text-primary placeholder-text-ghost"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Description <span className="text-text-ghost normal-case font-normal">— optional</span></label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={e => setNewDescription(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') resetForm() }}
                  placeholder="Unity project, environment art…"
                  className="input-riso w-full rounded px-3 py-2 text-sm text-text-primary placeholder-text-ghost"
                />
              </div>

              <div>
                <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Color</label>
                <div className="flex gap-2">
                  {PROJECT_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setNewColor(c)}
                      className={`w-5 h-5 rounded-full transition-all ${
                        newColor === c ? 'ring-2 ring-text-primary ring-offset-2 ring-offset-surface-2 scale-110' : 'opacity-60 hover:opacity-100 hover:scale-105'
                      }`}
                      style={{ backgroundColor: c, boxShadow: newColor === c ? `2px 2px 0px ${c}80` : undefined }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="px-5 py-3 border-t border-border flex gap-2">
              <button
                onClick={resetForm}
                disabled={creating}
                className="btn-riso btn-riso-secondary flex-1 text-[14px] py-2 rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || creating}
                className="btn-riso btn-riso-primary flex-1 text-[14px] py-2 rounded"
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
