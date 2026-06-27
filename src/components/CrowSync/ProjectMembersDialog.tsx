import { useEffect, useState, useCallback } from 'react'
import type { CrowSyncClient } from '../../api/client'
import type { Project, ProjectMember, Member, ApiError } from '../../types'

interface ProjectMembersDialogProps {
  client: CrowSyncClient
  project: Project
  currentMemberId: number | null
  onClose: () => void
}

export function ProjectMembersDialog({ client, project, currentMemberId, onClose }: ProjectMembersDialogProps) {
  const isAdmin = project.role === 'admin'
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [allMembers, setAllMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [addId, setAddId] = useState<number | ''>('')
  const [addRole, setAddRole] = useState<'admin' | 'member'>('member')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await client.listProjectMembers(project.id)
      setMembers(rows)
      // The global member list (for the add picker) is only needed by admins.
      if (isAdmin) setAllMembers(await client.listMembers())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load members')
    } finally {
      setLoading(false)
    }
  }, [client, project.id, isAdmin])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Run a membership mutation, refresh from its response, surface errors inline.
  const mutate = useCallback(async (fn: () => Promise<{ members: ProjectMember[] }>) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fn()
      setMembers(res.members)
    } catch (e) {
      const err = e as ApiError
      setError(typeof err.message === 'string' ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }, [])

  const handleAdd = async () => {
    if (addId === '') return
    await mutate(() => client.addProjectMember(project.id, Number(addId), addRole))
    setAddId('')
    setAddRole('member')
  }

  const memberIds = new Set(members.map(m => m.member_id))
  const addable = allMembers.filter(m => !memberIds.has(m.id) && m.is_active)

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="card-riso rounded-lg w-[520px] max-h-[85vh] flex flex-col overflow-hidden animate-riso-scale-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-surface-2 border-b border-border-active px-5 py-3 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-sm font-bold text-text-primary tracking-wide">Project members</h2>
            <p className="text-[12px] text-text-ghost font-mono">{project.name}</p>
          </div>
          <button onClick={onClose} className="btn-riso btn-riso-secondary w-6 h-6 px-0 text-sm rounded" title="Close">
            {'✕'}
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-4">
          {loading && <div className="py-8 text-center text-text-ghost text-xs uppercase tracking-widest">Loading…</div>}
          {error && <div className="text-danger text-[13px] bg-danger/10 border border-danger/30 rounded px-3 py-2">{error}</div>}

          {!loading && (
            <>
              {!isAdmin && (
                <p className="text-[12px] text-text-ghost">
                  You're a member of this project. Only project admins can change roles.
                </p>
              )}

              <div className="space-y-1.5">
                {members.map(m => (
                  <div key={m.member_id} className="flex items-center gap-2 text-[13px] py-1">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.avatar_color }} />
                    <span className="text-text-primary font-medium truncate flex-1">
                      {m.name}
                      {m.member_id === currentMemberId && <span className="text-text-ghost font-normal"> (you)</span>}
                    </span>

                    {isAdmin ? (
                      <select
                        value={m.role}
                        disabled={busy}
                        onChange={e => mutate(() => client.updateProjectMemberRole(project.id, m.member_id, e.target.value as 'admin' | 'member'))}
                        className="input-riso text-[12px] rounded px-1.5 py-0.5 font-mono"
                      >
                        <option value="admin">admin</option>
                        <option value="member">member</option>
                      </select>
                    ) : (
                      <span className="font-mono text-[12px] text-text-muted">{m.role}</span>
                    )}

                    {isAdmin && (
                      <button
                        onClick={() => mutate(() => client.removeProjectMember(project.id, m.member_id))}
                        disabled={busy}
                        className="btn-riso btn-riso-danger text-[11px] font-mono px-1.5 py-0.5 rounded shrink-0"
                        title="Remove from project"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                {members.length === 0 && (
                  <p className="text-[12px] text-text-ghost">No members.</p>
                )}
              </div>

              {isAdmin && (
                <div className="border-t border-border pt-3">
                  <label className="block text-[11px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Add member</label>
                  {addable.length === 0 ? (
                    <p className="text-[12px] text-text-ghost">All registered members are already in this project.</p>
                  ) : (
                    <div className="flex items-center gap-2">
                      <select
                        value={addId}
                        onChange={e => setAddId(e.target.value === '' ? '' : Number(e.target.value))}
                        className="input-riso text-[13px] rounded px-2 py-1 flex-1"
                      >
                        <option value="">Select a member…</option>
                        {addable.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                      <select
                        value={addRole}
                        onChange={e => setAddRole(e.target.value as 'admin' | 'member')}
                        className="input-riso text-[12px] rounded px-1.5 py-1 font-mono"
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
                      <button
                        onClick={handleAdd}
                        disabled={busy || addId === ''}
                        className="btn-riso btn-riso-primary text-[13px] font-mono px-3 py-1 rounded shrink-0"
                      >
                        Add
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
