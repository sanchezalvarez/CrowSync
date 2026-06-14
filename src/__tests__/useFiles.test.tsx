import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../test/mocks/server'
import { useFiles } from '../hooks/useFiles'
import { CrowSyncClient } from '../api/client'

const BASE = 'http://localhost:8001'
const PROJECT_ID = 1

function makeClient() {
  return new CrowSyncClient(BASE, 'tester', 'valid-key')
}

describe('useFiles', () => {
  it('loads file list on mount', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useFiles(client, PROJECT_ID, null))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.files).toHaveLength(1)
    expect(result.current.files[0].path).toBe('Assets/hero.fbx')
  })

  it('lockFile calls the lock endpoint and refreshes the list', async () => {
    const client = makeClient()

    const lockResult = {
      file: { id: 1, project_id: 1, path: 'Assets/hero.fbx', current_version: 1,
               size_bytes: 100, checksum: 'abc123', locked_by_id: 1,
               locked_by: { id: 1, name: 'tester' }, locked_at: '2026-06-14T10:00:00Z',
               last_synced_at: null, created_at: '' },
      locked: ['Assets/hero.fbx'],
      auto_meta: null,
      also_locked: [],
      skipped: [],
      group_id: null,
    }

    // Spy on the real client instance — methods remain on the prototype
    const lockSpy = vi.spyOn(client, 'lockFile').mockResolvedValue(lockResult)

    // After lock, GET /projects/1/files returns the file as locked
    server.use(
      http.get(`${BASE}/projects/1/files`, () =>
        HttpResponse.json([
          {
            id: 1, project_id: 1, path: 'Assets/hero.fbx', current_version: 1,
            size_bytes: 100, checksum: 'abc123',
            locked_by_id: 1, locked_by: { id: 1, name: 'tester' },
            locked_at: '2026-06-14T10:00:00Z',
            last_synced_at: null, created_at: '',
          },
        ]),
      ),
    )

    const { result } = renderHook(() => useFiles(client, PROJECT_ID, null))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.lockFile('Assets/hero.fbx', 'editing')
    })

    expect(lockSpy).toHaveBeenCalledWith(PROJECT_ID, 'Assets/hero.fbx', 'editing', [])
    await waitFor(() => expect(result.current.files[0].locked_by_id).toBe(1))
  })
})
