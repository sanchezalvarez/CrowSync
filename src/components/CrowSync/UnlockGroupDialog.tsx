interface UnlockGroupDialogProps {
  data: { path: string; count: number } | null
  onCancel: () => void
  onUnlock: (scope: 'file' | 'group') => void
}

function fileName(path: string): string {
  return path.split('/').pop() || path
}

export function UnlockGroupDialog({ data, onCancel, onUnlock }: UnlockGroupDialogProps) {
  if (!data) return null
  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="card-riso rounded-lg w-[400px] overflow-hidden animate-riso-scale-in">
        <div className="bg-locked-muted border-b border-locked/30 px-5 py-3">
          <h2 className="text-sm font-bold text-locked tracking-wide">Unlock lock group?</h2>
        </div>
        <div className="px-5 py-4">
          <p className="text-[14px] text-text-secondary">
            <span className="font-mono text-accent font-bold">{fileName(data.path)}</span> is part of a
            lock group of <span className="text-text-primary font-medium">{data.count} files</span>.
            Unlock only this file, or the whole group?
          </p>
        </div>
        <div className="px-5 py-3 border-t border-border flex gap-2">
          <button onClick={onCancel} className="btn-riso btn-riso-secondary flex-1 text-[12px] py-2 rounded">
            Cancel
          </button>
          <button onClick={() => onUnlock('file')} className="btn-riso btn-riso-secondary flex-1 text-[12px] py-2 rounded">
            Unlock this file
          </button>
          <button onClick={() => onUnlock('group')} className="btn-riso btn-riso-primary flex-1 text-[12px] font-medium py-2 rounded">
            Unlock whole group
          </button>
        </div>
      </div>
    </div>
  )
}
