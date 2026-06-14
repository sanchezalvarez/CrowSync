import { useState, useMemo, useEffect, useCallback } from 'react'
import type { FileEntry, CompareResult } from '../../types'
import { FILE_STATUS } from '../../types'

interface FileTreeProps {
  files: FileEntry[]
  comparison: CompareResult | null
  selectedPath: string | null
  onSelectFile: (file: FileEntry) => void
  onUpload: (path: string, file: File) => void
  onLock: (path: string) => void
  onUnlock: (path: string) => void
  onDownload: (path: string) => void
  onDelete: (path: string) => void
  currentMemberId: number | null
  isOnline: boolean
}

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  children: TreeNode[]
  file?: FileEntry
}

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      const pathSoFar = parts.slice(0, i + 1).join('/')
      if (isLast) {
        current.children.push({ name: part, path: pathSoFar, isDir: false, children: [], file })
      } else {
        let dir = current.children.find(c => c.isDir && c.name === part)
        if (!dir) {
          dir = { name: part, path: pathSoFar, isDir: true, children: [] }
          current.children.push(dir)
        }
        current = dir
      }
    }
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach(n => { if (n.isDir) sortNodes(n.children) })
  }
  sortNodes(root.children)
  return root.children
}

function getFileStatus(
  file: FileEntry, currentMemberId: number | null,
  conflictPaths: Set<string>, behindPaths: Set<string>,
): keyof typeof FILE_STATUS {
  if (conflictPaths.has(file.path)) return 'conflict'
  if (file.locked_by_id) return file.locked_by_id === currentMemberId ? 'locked_me' : 'locked'
  if (behindPaths.has(file.path)) return 'behind'
  return 'synced'
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

interface TreeItemProps {
  node: TreeNode
  depth: number
  selectedPath: string | null
  onSelectFile: (file: FileEntry) => void
  currentMemberId: number | null
  onContextMenu: (e: React.MouseEvent, file: FileEntry) => void
  expandedDirs: Set<string>
  toggleDir: (path: string) => void
  modifiedPaths: Set<string>
  newLocalPaths: Set<string>
  behindPaths: Set<string>
  conflictPaths: Set<string>
}

function TreeItem({
  node, depth, selectedPath, onSelectFile, currentMemberId,
  onContextMenu, expandedDirs, toggleDir, modifiedPaths, newLocalPaths,
  behindPaths, conflictPaths,
}: TreeItemProps) {
  const isExpanded = expandedDirs.has(node.path)

  if (node.isDir) {
    return (
      <div>
        <div
          onClick={() => toggleDir(node.path)}
          className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-surface-3/50 text-text-secondary select-none"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          <span className="text-[12px] text-text-ghost w-3 font-mono">{isExpanded ? '\u25BE' : '\u25B8'}</span>
          <span className="text-[14px] font-medium text-text-secondary">{node.name}/</span>
        </div>
        {isExpanded && node.children.map(child => (
          <TreeItem
            key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath}
            onSelectFile={onSelectFile} currentMemberId={currentMemberId}
            onContextMenu={onContextMenu} expandedDirs={expandedDirs} toggleDir={toggleDir}
            modifiedPaths={modifiedPaths} newLocalPaths={newLocalPaths}
            behindPaths={behindPaths} conflictPaths={conflictPaths}
          />
        ))}
      </div>
    )
  }

  const file = node.file!
  const status = getFileStatus(file, currentMemberId, conflictPaths, behindPaths)
  const statusInfo = FILE_STATUS[status]
  const isSelected = selectedPath === file.path
  const localStatus = modifiedPaths.has(file.path) ? 'modified' : newLocalPaths.has(file.path) ? 'new' : null

  return (
    <div
      onClick={() => onSelectFile(file)}
      onContextMenu={e => onContextMenu(e, file)}
      className={`flex items-center gap-1.5 px-2 py-1.5 cursor-pointer select-none transition-colors ${
        isSelected ? 'bg-surface-3' : 'hover:bg-surface-2'
      }`}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
    >
      <span className="text-[13px]" title={statusInfo.label}>{statusInfo.icon}</span>
      <span className={`text-[14px] truncate ${isSelected ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>{node.name}</span>
      {file.locked_by && (
        <span
          className={`text-[11px] truncate shrink min-w-0 ${status === 'locked_me' ? 'text-sync' : 'text-locked'}`}
          title={`locked by ${file.locked_by.name} ${relativeTime(file.locked_at)}${file.lock_group_id ? ' · part of a lock group' : ''}${file.lock_reason ? ` — ${file.lock_reason}` : ''}`}
        >
          {file.lock_group_id && <span className="opacity-70" title="Part of a lock group">{'🔗'}</span>}
          {'🔒'} {file.locked_by.name} · {relativeTime(file.locked_at)}
        </span>
      )}
      <span className="flex-1" />
      {localStatus && (
        <span className={`text-[11px] font-mono font-bold px-1 py-px rounded shrink-0 ${
          localStatus === 'modified' ? 'bg-accent-muted text-accent' : 'bg-sync-muted text-sync'
        }`}>
          {localStatus === 'modified' ? 'MOD' : 'NEW'}
        </span>
      )}
      <span className="text-[12px] text-text-muted font-mono shrink-0">v{file.current_version}</span>
      <span className="text-[12px] text-text-ghost font-mono shrink-0">{formatSize(file.size_bytes)}</span>
    </div>
  )
}

export function FileTree({
  files, comparison, selectedPath, onSelectFile, onUpload, onLock, onUnlock,
  onDownload, onDelete, currentMemberId, isOnline,
}: FileTreeProps) {
  const modifiedPaths = useMemo(() => {
    if (!comparison) return new Set<string>()
    return new Set(comparison.modified_local.map(f => f.path))
  }, [comparison])

  const newLocalPaths = useMemo(() => {
    if (!comparison) return new Set<string>()
    return new Set(comparison.new_local.map(f => f.path))
  }, [comparison])

  const behindPaths = useMemo(() => {
    if (!comparison) return new Set<string>()
    return new Set(comparison.behind.map(f => f.path))
  }, [comparison])

  const conflictPaths = useMemo(() => {
    if (!comparison) return new Set<string>()
    return new Set(comparison.conflict.map(f => f.path))
  }, [comparison])

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileEntry } | null>(null)
  const tree = useMemo(() => buildTree(files), [files])

  // Auto-expand every directory the first time the tree populates. A side effect
  // (setState), so it belongs in an effect, not useMemo — guarded so it runs once.
  useEffect(() => {
    if (expandedDirs.size > 0) return
    const dirs = new Set<string>()
    const collectDirs = (nodes: TreeNode[]) => {
      nodes.forEach(n => { if (n.isDir) { dirs.add(n.path); collectDirs(n.children) } })
    }
    collectDirs(tree)
    // Intentional one-time population (guarded above) when the tree first loads.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (dirs.size > 0) setExpandedDirs(dirs)
  }, [tree, expandedDirs.size])

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      return next
    })
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, file: FileEntry) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, file })
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const items = e.dataTransfer.items
    if (!items) return

    // Use webkitGetAsEntry to preserve directory structure
    const processEntry = (entry: FileSystemEntry, basePath: string) => {
      if (entry.isFile) {
        (entry as FileSystemFileEntry).file(file => {
          const path = basePath ? `${basePath}/${file.name}` : file.name
          onUpload(path, file)
        })
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader()
        reader.readEntries(entries => {
          const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name
          entries.forEach(e => processEntry(e, dirPath))
        })
      }
    }

    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.()
      if (entry) {
        processEntry(entry, '')
      } else {
        const file = items[i].getAsFile()
        if (file) onUpload(file.name, file)
      }
    }
  }, [onUpload])

  return (
    <div
      className="flex-1 flex flex-col h-full bg-surface-0 relative"
      onDragOver={e => e.preventDefault()}
      onDrop={handleDrop}
      onClick={() => setContextMenu(null)}
    >
      <div className="flex-1 overflow-y-auto py-0.5">
        {tree.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-ghost text-xs">
            <span className="text-2xl mb-2 opacity-30">{'\uD83D\uDCC2'}</span>
            <span>No files</span>
          </div>
        ) : (
          tree.map(node => (
            <TreeItem
              key={node.path} node={node} depth={0} selectedPath={selectedPath}
              onSelectFile={onSelectFile} currentMemberId={currentMemberId}
              onContextMenu={handleContextMenu} expandedDirs={expandedDirs} toggleDir={toggleDir}
              modifiedPaths={modifiedPaths} newLocalPaths={newLocalPaths}
              behindPaths={behindPaths} conflictPaths={conflictPaths}
            />
          ))
        )}
      </div>

      {contextMenu && (
        <div
          className="fixed bg-surface-2 border border-border-active rounded py-1 z-50 min-w-36 animate-riso-scale-in"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            boxShadow: 'var(--shadow-riso-md-dark)',
          }}
        >
          {[
            { label: 'Download', action: () => onDownload(contextMenu.file.path), always: true, danger: false },
            { label: 'Lock', action: () => onLock(contextMenu.file.path), show: !contextMenu.file.locked_by_id, danger: false },
            { label: 'Unlock', action: () => onUnlock(contextMenu.file.path), show: !!contextMenu.file.locked_by_id, danger: false },
            { label: 'Delete', action: () => onDelete(contextMenu.file.path), always: true, danger: true },
          ].filter(item => item.always || item.show).map(item => (
            <button
              key={item.label}
              onClick={() => { item.action(); setContextMenu(null) }}
              disabled={!isOnline}
              className={`w-full text-left px-3 py-1.5 text-[14px] disabled:opacity-30 transition-colors ${
                item.danger
                  ? 'text-danger hover:bg-danger/10'
                  : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
