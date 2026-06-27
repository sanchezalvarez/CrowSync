import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../test/mocks/server'
import { StatsDialog } from '../components/CrowSync/StatsDialog'
import { CrowSyncClient } from '../api/client'
import type { ProjectStats } from '../types'

const BASE = 'http://localhost:8001'
const PROJECT_ID = 1

function makeClient() {
  return new CrowSyncClient(BASE, 'tester', 'valid-key')
}

const SAMPLE: ProjectStats = {
  storage: { file_count: 3, files_bytes: 3000, version_count: 5, version_bytes: 8000, total_bytes: 11000 },
  locks: { total: 1, by_member: [{ member_id: 1, member_name: 'tester', avatar_color: '#0B7268', count: 1 }] },
  contributors: [{ member_id: 1, member_name: 'tester', avatar_color: '#0B7268', actions: 4 }],
  file_types: [{ ext: '.fbx', count: 2, bytes: 2000 }, { ext: '(none)', count: 1, bytes: 1000 }],
  heatmap: [{ day: new Date().toISOString().slice(0, 10), count: 3 }],
}

function mockStats(data: ProjectStats) {
  server.use(http.get(`${BASE}/projects/1/stats`, () => HttpResponse.json(data)))
}

describe('StatsDialog', () => {
  it('renders storage, locks, contributors and heatmap', async () => {
    mockStats(SAMPLE)
    render(<StatsDialog client={makeClient()} projectId={PROJECT_ID} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByText('10.7 KB')).toBeInTheDocument()) // 11000 total
    expect(screen.getByText(/3 current files/)).toBeInTheDocument()
    expect(screen.getByText(/5 versions/)).toBeInTheDocument()
    expect(screen.getByText('Active locks (1)')).toBeInTheDocument()
    expect(screen.getByText('1 file')).toBeInTheDocument()
    expect(screen.getByText(/\.fbx \(2\)/)).toBeInTheDocument()
    // Heatmap grid is present with the labelled role.
    expect(screen.getByRole('grid', { name: /activity heatmap/i })).toBeInTheDocument()
  })

  it('shows empty states without crashing on a fresh project', async () => {
    mockStats({
      storage: { file_count: 0, files_bytes: 0, version_count: 0, version_bytes: 0, total_bytes: 0 },
      locks: { total: 0, by_member: [] },
      contributors: [],
      file_types: [],
      heatmap: [],
    })
    render(<StatsDialog client={makeClient()} projectId={PROJECT_ID} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByText('No active locks.')).toBeInTheDocument())
    expect(screen.getByText('No uploads yet.')).toBeInTheDocument()
  })

  it('surfaces an error if the request fails', async () => {
    server.use(http.get(`${BASE}/projects/1/stats`, () => HttpResponse.json({ detail: 'boom' }, { status: 500 })))
    render(<StatsDialog client={makeClient()} projectId={PROJECT_ID} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
  })

  it('calls onClose when the close button is clicked', async () => {
    mockStats(SAMPLE)
    const onClose = vi.fn()
    render(<StatsDialog client={makeClient()} projectId={PROJECT_ID} onClose={onClose} />)
    await waitFor(() => expect(screen.getByTitle('Close')).toBeInTheDocument())
    screen.getByTitle('Close').click()
    expect(onClose).toHaveBeenCalled()
  })
})
