import { useEffect, useState } from 'react'
import type { CrowSyncClient } from '../../api/client'
import type { ProjectStats } from '../../types'

interface StatsDialogProps {
  client: CrowSyncClient
  projectId: number
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

const HEATMAP_DAYS = 84  // matches server window (12 weeks)

/** Build the last HEATMAP_DAYS as week-columns × weekday-rows, padded so the first
 *  column aligns to Sunday. Returns a flat list (nulls are leading pad cells). */
function buildHeatmapCells(counts: Map<string, number>): Array<{ day: string; count: number } | null> {
  const today = new Date()
  const days: Array<{ day: string; count: number }> = []
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    const key = d.toISOString().slice(0, 10)  // YYYY-MM-DD (UTC, like the server)
    days.push({ day: key, count: counts.get(key) ?? 0 })
  }
  // Pad the front so column 0 starts on Sunday (getUTCDay of the oldest day).
  const firstWeekday = new Date(days[0].day).getUTCDay()
  const pad: Array<null> = Array(firstWeekday).fill(null)
  return [...pad, ...days]
}

function heatColor(count: number, max: number): string {
  if (count === 0) return 'bg-surface-3'
  const ratio = max > 0 ? count / max : 0
  if (ratio > 0.66) return 'bg-accent'
  if (ratio > 0.33) return 'bg-accent/60'
  return 'bg-accent/30'
}

/** A horizontal bar row used by both the contributors and file-type breakdowns. */
function BarRow({ label, valueText, ratio, color }: { label: string; valueText: string; ratio: number; color?: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-28 shrink-0 truncate font-mono text-text-secondary" title={label}>{label}</span>
      <div className="flex-1 h-3 bg-surface-3 rounded overflow-hidden">
        <div
          className="h-full rounded"
          style={{ width: `${Math.max(ratio * 100, 3)}%`, backgroundColor: color || 'var(--color-accent)' }}
        />
      </div>
      <span className="w-20 shrink-0 text-right font-mono text-text-muted">{valueText}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-mono font-bold text-text-muted uppercase tracking-widest">{title}</h3>
      {children}
    </div>
  )
}

export function StatsDialog({ client, projectId, onClose }: StatsDialogProps) {
  const [data, setData] = useState<ProjectStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const d = await client.getStats(projectId)
        if (!cancelled) setData(d)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load stats')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [client, projectId])

  // Esc closes, like the other dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const maxContrib = data?.contributors.reduce((m, c) => Math.max(m, c.actions), 0) ?? 0
  const maxTypeBytes = data?.file_types.reduce((m, t) => Math.max(m, t.bytes), 0) ?? 0
  const heatCounts = new Map((data?.heatmap ?? []).map(h => [h.day, h.count]))
  const heatCells = buildHeatmapCells(heatCounts)
  const heatMax = data?.heatmap.reduce((m, h) => Math.max(m, h.count), 0) ?? 0

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="card-riso rounded-lg w-[640px] max-h-[85vh] flex flex-col overflow-hidden animate-riso-scale-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-surface-2 border-b border-border-active px-5 py-3 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-bold text-text-primary tracking-wide">Project stats</h2>
          <button onClick={onClose} className="btn-riso btn-riso-secondary w-6 h-6 px-0 text-sm rounded" title="Close">
            {'✕'}
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-5">
          {loading && <div className="py-10 text-center text-text-ghost text-xs uppercase tracking-widest">Loading…</div>}
          {error && <div className="py-6 text-center text-danger text-[13px]">{error}</div>}

          {data && !loading && (
            <>
              {/* Storage */}
              <Section title="Storage">
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-surface-2 border border-border rounded px-3 py-2">
                    <div className="text-[18px] font-mono font-bold text-accent">{formatSize(data.storage.total_bytes)}</div>
                    <div className="text-[11px] text-text-ghost uppercase tracking-wide">total on disk</div>
                  </div>
                  <div className="bg-surface-2 border border-border rounded px-3 py-2">
                    <div className="text-[18px] font-mono font-bold text-text-primary">{formatSize(data.storage.files_bytes)}</div>
                    <div className="text-[11px] text-text-ghost uppercase tracking-wide">{data.storage.file_count} current files</div>
                  </div>
                  <div className="bg-surface-2 border border-border rounded px-3 py-2">
                    <div className="text-[18px] font-mono font-bold text-text-primary">{formatSize(data.storage.version_bytes)}</div>
                    <div className="text-[11px] text-text-ghost uppercase tracking-wide">{data.storage.version_count} versions (history)</div>
                  </div>
                </div>
              </Section>

              {/* Active locks */}
              <Section title={`Active locks (${data.locks.total})`}>
                {data.locks.by_member.length === 0 ? (
                  <p className="text-[12px] text-text-ghost">No active locks.</p>
                ) : (
                  <div className="space-y-1.5">
                    {data.locks.by_member.map(m => (
                      <div key={m.member_id} className="flex items-center gap-2 text-[13px]">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.avatar_color }} />
                        <span className="text-text-primary font-medium truncate flex-1">{m.member_name}</span>
                        <span className="font-mono text-locked shrink-0">{m.count} {m.count === 1 ? 'file' : 'files'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* Top contributors */}
              <Section title="Top contributors (uploads)">
                {data.contributors.length === 0 ? (
                  <p className="text-[12px] text-text-ghost">No uploads yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {data.contributors.map(c => (
                      <BarRow
                        key={c.member_id}
                        label={c.member_name}
                        valueText={`${c.actions}`}
                        ratio={maxContrib > 0 ? c.actions / maxContrib : 0}
                        color={c.avatar_color}
                      />
                    ))}
                  </div>
                )}
              </Section>

              {/* File-type breakdown */}
              <Section title="File types">
                {data.file_types.length === 0 ? (
                  <p className="text-[12px] text-text-ghost">No files.</p>
                ) : (
                  <div className="space-y-1.5">
                    {data.file_types.map(t => (
                      <BarRow
                        key={t.ext}
                        label={`${t.ext} (${t.count})`}
                        valueText={formatSize(t.bytes)}
                        ratio={maxTypeBytes > 0 ? t.bytes / maxTypeBytes : 0}
                      />
                    ))}
                  </div>
                )}
              </Section>

              {/* Activity heatmap */}
              <Section title="Activity (last 12 weeks)">
                <div className="grid grid-rows-7 grid-flow-col gap-1 w-max" role="grid" aria-label="activity heatmap">
                  {heatCells.map((cell, i) =>
                    cell === null ? (
                      <span key={`pad-${i}`} className="w-3 h-3" />
                    ) : (
                      <span
                        key={cell.day}
                        className={`w-3 h-3 rounded-sm ${heatColor(cell.count, heatMax)}`}
                        title={`${cell.day}: ${cell.count} ${cell.count === 1 ? 'action' : 'actions'}`}
                      />
                    )
                  )}
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
