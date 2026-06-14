import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/mocks/server'
import { CrowSyncClient } from '../api/client'

const BASE = 'http://localhost:8001'

function makeClient(overrides?: { apiKey?: string; adminToken?: string; onUnauthorized?: () => void }) {
  if (overrides?.adminToken) {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) =>
      key === 'crowsync_admin_token' ? overrides.adminToken! : null,
    )
  }
  return new CrowSyncClient(BASE, 'tester', overrides?.apiKey ?? 'valid-key', overrides?.onUnauthorized)
}

describe('CrowSyncClient', () => {
  describe('auth headers', () => {
    it('attaches X-Member-Name and X-Api-Key on every request', async () => {
      let captured: Headers | null = null
      server.use(
        http.get(`${BASE}/projects`, ({ request }) => {
          captured = request.headers
          return HttpResponse.json([])
        }),
      )
      await makeClient({ apiKey: 'my-key' }).listProjects()
      expect(captured!.get('x-member-name')).toBe('tester')
      expect(captured!.get('x-api-key')).toBe('my-key')
    })

    it('attaches X-Admin-Token from localStorage when set', async () => {
      let captured: Headers | null = null
      server.use(
        http.get(`${BASE}/projects`, ({ request }) => {
          captured = request.headers
          return HttpResponse.json([])
        }),
      )
      await makeClient({ adminToken: 'super-secret' }).listProjects()
      expect(captured!.get('x-admin-token')).toBe('super-secret')
    })
  })

  describe('401 handling', () => {
    it('calls onUnauthorized callback on 401 response', async () => {
      server.use(
        http.get(`${BASE}/projects`, () => HttpResponse.json({ detail: 'bad key' }, { status: 401 })),
      )
      const onUnauthorized = vi.fn()
      await expect(makeClient({ onUnauthorized }).listProjects()).rejects.toThrow()
      expect(onUnauthorized).toHaveBeenCalledOnce()
    })

    it('does not call onUnauthorized on non-401 errors', async () => {
      server.use(
        http.get(`${BASE}/projects`, () => HttpResponse.json({ detail: 'not found' }, { status: 404 })),
      )
      const onUnauthorized = vi.fn()
      await expect(makeClient({ onUnauthorized }).listProjects()).rejects.toThrow()
      expect(onUnauthorized).not.toHaveBeenCalled()
    })
  })

  describe('lockFile', () => {
    it('sends correct JSON body with path, reason, and also fields', async () => {
      let body: unknown = null
      server.use(
        http.post(`${BASE}/projects/1/files/lock`, async ({ request }) => {
          body = await request.json()
          return HttpResponse.json({
            file: { id: 1 }, locked: ['Assets/hero.fbx'],
            auto_meta: null, also_locked: [], skipped: [], group_id: null,
          })
        }),
      )
      await makeClient().lockFile(1, 'Assets/hero.fbx', 'fixing pivot', ['Assets/hero.fbx.meta'])
      expect(body).toEqual({
        path: 'Assets/hero.fbx',
        reason: 'fixing pivot',
        also: ['Assets/hero.fbx.meta'],
      })
    })
  })

  describe('uploadFile', () => {
    it('sends path as a query param and file as multipart', async () => {
      let url: string | null = null
      let isMultipart = false
      server.use(
        http.post(`${BASE}/projects/1/files/upload`, ({ request }) => {
          url = request.url
          isMultipart = request.headers.get('content-type')?.includes('multipart') ?? false
          return HttpResponse.json({
            id: 1, project_id: 1, path: 'Assets/x.bin',
            current_version: 1, size_bytes: 3, checksum: 'abc',
            locked_by_id: null, locked_by: null, locked_at: null,
            last_synced_at: null, created_at: '',
          })
        }),
      )
      await makeClient().uploadFile(1, 'Assets/x.bin', new Blob([new Uint8Array([1, 2, 3])]))
      expect(url).toContain('path=Assets%2Fx.bin')
      expect(isMultipart).toBe(true)
    })
  })
})
