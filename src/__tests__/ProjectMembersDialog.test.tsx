import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../test/mocks/server'
import { ProjectMembersDialog } from '../components/CrowSync/ProjectMembersDialog'
import { CrowSyncClient } from '../api/client'
import type { Project, ProjectMember } from '../types'

const BASE = 'http://localhost:8001'

function makeClient() {
  return new CrowSyncClient(BASE, 'alice', 'valid-key')
}

const PROJECT_MEMBERS: ProjectMember[] = [
  { member_id: 1, name: 'alice', email: '', avatar_color: '#0B7268', role: 'admin', created_at: '' },
  { member_id: 2, name: 'bob', email: '', avatar_color: '#E04E0E', role: 'member', created_at: '' },
]

function mockMembers(rows: ProjectMember[] = PROJECT_MEMBERS) {
  server.use(
    http.get(`${BASE}/projects/1/members`, () => HttpResponse.json(rows)),
    http.get(`${BASE}/members`, () => HttpResponse.json([
      { id: 1, name: 'alice', email: '', avatar_color: '#0B7268', is_active: 1, created_at: '' },
      { id: 2, name: 'bob', email: '', avatar_color: '#E04E0E', is_active: 1, created_at: '' },
      { id: 3, name: 'carol', email: '', avatar_color: '#5B8DEF', is_active: 1, created_at: '' },
    ])),
  )
}

const adminProject: Project = { id: 1, name: 'Game', description: '', color: '#fff', root_path: '', created_at: '', role: 'admin' }
const memberProject: Project = { ...adminProject, role: 'member' }

describe('ProjectMembersDialog', () => {
  it('renders the member list with roles', async () => {
    mockMembers()
    render(<ProjectMembersDialog client={makeClient()} project={adminProject} currentMemberId={1} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument())
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('(you)')).toBeInTheDocument() // alice is current member
  })

  it('admin sees add/remove controls', async () => {
    mockMembers()
    render(<ProjectMembersDialog client={makeClient()} project={adminProject} currentMemberId={1} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument())
    expect(screen.getAllByText('Remove').length).toBeGreaterThan(0)
    expect(screen.getByText('Add member')).toBeInTheDocument()
  })

  it('non-admin sees a read-only list (no controls)', async () => {
    mockMembers()
    render(<ProjectMembersDialog client={makeClient()} project={memberProject} currentMemberId={2} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument())
    expect(screen.queryByText('Remove')).not.toBeInTheDocument()
    expect(screen.queryByText('Add member')).not.toBeInTheDocument()
    expect(screen.getByText(/Only project admins can change roles/)).toBeInTheDocument()
  })

  it('removing a member calls the client and refreshes', async () => {
    mockMembers()
    const client = makeClient()
    const spy = vi.spyOn(client, 'removeProjectMember').mockResolvedValue({
      ok: true, members: [PROJECT_MEMBERS[0]],
    })
    render(<ProjectMembersDialog client={client} project={adminProject} currentMemberId={1} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument())

    await userEvent.click(screen.getAllByText('Remove')[1]) // bob's row
    expect(spy).toHaveBeenCalledWith(1, 2)
    // After removal only alice's row remains (bob may reappear as an <option> in the
    // add-member picker, so assert on the row controls rather than the name text).
    await waitFor(() => expect(screen.getAllByText('Remove')).toHaveLength(1))
  })

  it('surfaces a server error (e.g. last-admin guard)', async () => {
    mockMembers()
    const client = makeClient()
    vi.spyOn(client, 'updateProjectMemberRole').mockRejectedValue(
      Object.assign(new Error('Project must keep at least one admin'), { status: 409 }),
    )
    render(<ProjectMembersDialog client={client} project={adminProject} currentMemberId={1} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument())

    const aliceSelect = screen.getAllByRole('combobox')[0]
    await userEvent.selectOptions(aliceSelect, 'member')
    await waitFor(() => expect(screen.getByText('Project must keep at least one admin')).toBeInTheDocument())
  })
})
