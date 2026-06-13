import { useEffect, useRef } from 'react'
import type { Activity, SyncEvent } from '../../types'

interface ActivityFeedProps {
  activities: Activity[]
  events: SyncEvent[]
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

export function ActivityFeed({ activities, events }: ActivityFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Newest entries render at the top — keep the view pinned there as they arrive.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [activities.length, events.length])

  const total = events.length + activities.length

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
        {events.length === 0 && activities.length === 0 ? (
          <div className="px-3 py-10 text-center text-text-ghost text-xs tracking-widest uppercase">No activity yet</div>
        ) : (
          <>
            {events.map((e, i) => (
              <LogRow
                key={`ws-${i}`} live action={e.event} member={e.data.member || 'Someone'}
                text={`${e.event} ${e.data.path || ''}`.trim()} time={formatTime(e.at)}
              />
            ))}
            {activities.map(a => (
              <LogRow
                key={a.id} action={a.action} member={a.member_name || 'System'}
                text={a.detail || `${a.action} ${a.file_path}`} time={formatTime(a.created_at)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
