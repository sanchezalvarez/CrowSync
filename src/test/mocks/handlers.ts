import { http, HttpResponse } from 'msw'

const BASE = 'http://localhost:8001'

export const handlers = [
  http.get(`${BASE}/health`, () =>
    HttpResponse.json({ status: 'ok', version: '0.1.0', projects: 0, members: 1 }),
  ),

  http.get(`${BASE}/projects`, () => HttpResponse.json([])),

  http.post(`${BASE}/projects`, () =>
    HttpResponse.json(
      { id: 1, name: 'TestProject', description: '', color: '#E04E0E', root_path: '', created_at: '' },
      { status: 201 },
    ),
  ),

  http.get(`${BASE}/projects/1/files`, () =>
    HttpResponse.json([
      {
        id: 1, project_id: 1, path: 'Assets/hero.fbx', current_version: 1,
        size_bytes: 100, checksum: 'abc123',
        locked_by_id: null, locked_by: null, locked_at: null,
        last_synced_at: null, created_at: '',
      },
    ]),
  ),

  http.post(`${BASE}/projects/1/files/lock`, async ({ request }) => {
    const body = await request.json() as { path: string; reason?: string; also?: string[] }
    return HttpResponse.json({
      file: { id: 1, path: body.path },
      locked: [body.path],
      auto_meta: null,
      also_locked: [],
      skipped: [],
      group_id: null,
    })
  }),

  http.post(`${BASE}/projects/1/files/unlock`, () =>
    HttpResponse.json({
      id: 1, project_id: 1, path: 'Assets/hero.fbx', current_version: 1,
      size_bytes: 100, checksum: 'abc123',
      locked_by_id: null, locked_by: null, locked_at: null,
      last_synced_at: null, created_at: '',
    }),
  ),

  http.post(`${BASE}/members`, () =>
    HttpResponse.json(
      { id: 1, name: 'tester', email: '', avatar_color: '#0B7268', api_key: 'test-key-32chars123456789012', is_active: 1, created_at: '' },
      { status: 201 },
    ),
  ),
]
