import { describe, it, expect, vi } from 'vitest'

// Make getInvoke() return undefined → exercises the "browser mode" fallback paths
vi.mock('@tauri-apps/api/core', () => ({ invoke: undefined }))

import { isNativeAvailable, scanDir, nativeDownload } from '../utils/nativeFs'

describe('nativeFs (browser mode)', () => {
  it('isNativeAvailable returns false when __TAURI_INTERNALS__ is absent', () => {
    expect(isNativeAvailable()).toBe(false)
  })

  it('scanDir throws when native is unavailable', async () => {
    await expect(scanDir('/some/path', [])).rejects.toThrow('Native scan unavailable')
  })

  it('nativeDownload throws when native is unavailable', async () => {
    await expect(
      nativeDownload({
        serverUrl: 'http://localhost:8001',
        memberName: 'tester',
        apiKey: 'key',
        projectId: 1,
        relPath: 'Assets/hero.fbx',
        destAbsPath: '/tmp/hero.fbx',
      }),
    ).rejects.toThrow('Native download unavailable')
  })
})
