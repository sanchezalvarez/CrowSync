import { useEffect, useMemo, useRef, useState } from 'react'
import type { Activity, SyncEvent, PullSession } from '../../types'

interface ActivityFeedProps {
  activities: Activity[]
  events: SyncEvent[]
  pullSessions?: PullSession[]
  onRevertPullSession?: (id: number) => void
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const ACTION_COLORS: Record<string, string> = {
  upload: 'text-accent',
  download: 'text-pull',
  lock: 'text-locked',
  auto_lock_meta: 'text-locked',
  unlock: 'text-sync',
  revert: 'text-pull',
  delete: 'text-danger',
  warning: 'text-locked',
  push: 'text-accent',
  pull: 'text-pull',
}

interface LogRowProps {
  action: string
  member: string
  text: string
  time: string
  live?: boolean
}

const ACTION_BORDER: Record<string, string> = {
  upload: 'border-l-accent',
  download: 'border-l-pull',
  lock: 'border-l-locked',
  auto_lock_meta: 'border-l-locked',
  unlock: 'border-l-sync',
  revert: 'border-l-pull',
  delete: 'border-l-danger',
  warning: 'border-l-locked',
  push: 'border-l-accent',
  pull: 'border-l-pull',
}

function LogRow({ action, member, text, time, live }: LogRowProps) {
  const borderClass = ACTION_BORDER[action] || 'border-l-border-active'
  return (
    <div className={`log-entry px-3 py-1.5 border-b border-border/40 border-l-2 ${borderClass} hover:bg-surface-2/50 transition-colors`}>
      <div className="flex items-center gap-1.5 text-[13px]">
        <span className={`${ACTION_COLORS[action] || 'text-text-muted'} text-[12px]`}>{'●'}</span>
        <span className="text-text-primary font-medium truncate">{member}</span>
        {live && (
          <span className="text-[12px] font-mono font-bold text-sync bg-sync-muted px-1 rounded shrink-0 animate-riso-pulse">
            LIVE
          </span>
        )}
        <span className="text-text-ghost font-mono ml-auto shrink-0 text-[12px]">{time}</span>
      </div>
      <p className="text-[13px] text-text-secondary truncate pl-3 mt-0.5" title={text}>{text}</p>
    </div>
  )
}

interface PullSessionRowProps {
  session: PullSession
  expanded: boolean
  onToggle: () => void
  onRevert?: () => void
}

function PullSessionRow({ session, expanded, onToggle, onRevert }: PullSessionRowProps) {
  const hasRevertable = session.files.some(f => f.pre_version > 0)

  // Summarise file names for compact display (1-2 files → names, else count).
  let summary: string
  if (session.file_count === 1 && session.files.length === 1) {
    summary = `pulled ${session.files[0].file_path.split('/').pop() || session.files[0].file_path}`
  } else if (session.file_count === 2 && session.files.length === 2) {
    const names = session.files.map(f => f.file_path.split('/').pop() || f.file_path)
    summary = `pulled ${names.join(', ')}`
  } else {
    summary = `pulled ${session.file_count} files`
  }

  return (
    <div className="log-entry border-b border-border/40 border-l-2 border-l-pull hover:bg-surface-2/50 transition-colors">
      <div className="px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-[13px]">
          <span className="text-pull text-[12px]">{'↓'}</span>
          <span className="text-text-primary font-medium truncate">{session.member_name}</span>
          <span className="text-text-ghost font-mono ml-auto shrink-0 text-[12px]">{formatTime(session.created_at)}</span>
        </div>
        <div className="flex items-center gap-1 pl-3 mt-0.5">
          <p className="text-[13px] text-text-secondary truncate flex-1" title={summary}>{summary}</p>
          <button
            onClick={onToggle}
            className="btn-riso btn-riso-secondary text-[11px] font-mono px-1 py-px rounded shrink-0"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '˅' : '›'}
          </button>
          {hasRevertable && onRevert && (
            <button
              onClick={onRevert}
              className="btn-riso btn-riso-danger text-[11px] font-mono px-1 py-px rounded shrink-0"
              title="Revert this pull (restore server files to pre-pull versions)"
            >
              Revert
            </button>
          )}
        </div>
      </div>
      {expanded && session.files.length > 0 && (
        <div className="px-3 pb-1.5 pl-6 space-y-0.5">
          {session.files.map((f, i) => (
            <div key={i} className="flex items-center gap-1 text-[11px] font-mono text-text-ghost">
              <span className="truncate flex-1" title={f.file_path}>{f.file_path.split('/').pop() || f.file_path}</span>
              <span className="shrink-0 text-text-ghost/60">
                {f.pre_version > 0 ? `v${f.pre_version}` : 'new'}{' → '}v{f.new_version}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Merge activities + pull sessions into a single chronological list (newest first). */
type FeedItem =
  | { kind: 'activity'; at: string; data: Activity }
  | { kind: 'ws'; at: string; data: SyncEvent }
  | { kind: 'pull'; at: string; data: PullSession }

export function ActivityFeed({ activities, events, pullSessions = [], onRevertPullSession }: ActivityFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expandedSession, setExpandedSession] = useState<number | null>(null)

  // Newest entries render at the top — keep the view pinned there as they arrive.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [activities.length, events.length, pullSessions.length])

  // Build a merged, sorted feed. Memoized so the expand toggle (and unrelated
  // parent re-renders) don't re-spread + re-sort the whole log every render.
  const feed: FeedItem[] = useMemo(() => [
    ...events.map(e => ({ kind: 'ws' as const, at: e.at, data: e })),
    ...activities.map(a => ({ kind: 'activity' as const, at: a.created_at, data: a })),
    ...pullSessions.map(ps => ({ kind: 'pull' as const, at: ps.created_at, data: ps })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)), [events, activities, pullSessions])

  const total = events.length + activities.length + pullSessions.length

  return (
    <div className="w-64 bg-surface-1 border-l border-border-active flex flex-col h-full shrink-0">
      <div className="px-3 py-2.5 border-b border-border-active flex items-center justify-between shrink-0">
        <span className="text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest">Log</span>
        {total > 0 && (
          <span className="text-[11px] font-mono font-bold text-text-ghost bg-surface-3 border border-border-active px-1.5 py-px rounded"
            style={{ boxShadow: '1px 1px 0px var(--color-border-active)' }}>
            {total}
          </span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {feed.length === 0 ? (
          <div className="px-3 py-10 text-center text-text-ghost text-xs tracking-widest uppercase">No activity yet</div>
        ) : (
          feed.map((item, i) => {
            if (item.kind === 'ws') {
              const e = item.data
              return (
                <LogRow
                  key={`ws-${i}`} live action={e.event} member={e.data.member || 'Someone'}
                  text={`${e.event} ${e.data.path || ''}`.trim()} time={formatTime(e.at)}
                />
              )
            }
            if (item.kind === 'activity') {
              const a = item.data
              return (
                <LogRow
                  key={`act-${a.id}`} action={a.action} member={a.member_name || 'System'}
                  text={a.detail || `${a.action} ${a.file_path}`} time={formatTime(a.created_at)}
                />
              )
            }
            // kind === 'pull'
            const ps = item.data
            return (
              <PullSessionRow
                key={`pull-${ps.id}`}
                session={ps}
                expanded={expandedSession === ps.id}
                onToggle={() => setExpandedSession(prev => prev === ps.id ? null : ps.id)}
                onRevert={onRevertPullSession ? () => onRevertPullSession(ps.id) : undefined}
              />
            )
          })
        )}
      </div>
    </div>
  )
}
