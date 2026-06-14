import type { Project, Member, FileEntry, Version, Activity, CompareManifestEntry, CompareTombstone, CompareResult, ServerSettings, LockResult, LockSuggestionResult, ApiError } from '../types'

export class CrowSyncClient {
  private baseUrl: string
  private memberName: string
  private apiKey: string
  private onUnauthorized?: () => void

  constructor(baseUrl: string, memberName: string, apiKey = '', onUnauthorized?: () => void) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.memberName = memberName
    this.apiKey = apiKey
    // Called when an authenticated request comes back 401 — the stored session
    // is invalid (server doesn't know this member/key). Lets App return to setup
    // instead of failing silently on every call.
    this.onUnauthorized = onUnauthorized
  }

  // Read-only accessors so native (Rust) transfers can reuse the same credentials.
  get serverUrl(): string { return this.baseUrl }
  get member(): string { return this.memberName }
  get key(): string { return this.apiKey }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'X-Member-Name': this.memberName }
    if (this.apiKey) h['X-Api-Key'] = this.apiKey
    // Admins store a token in setup; send it so destructive endpoints (delete
    // project/member, change settings) pass require_admin. Harmless elsewhere (S1).
    const adminToken = typeof localStorage !== 'undefined' ? localStorage.getItem('crowsync_admin_token') : null
    if (adminToken) h['X-Admin-Token'] = adminToken
    return h
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...this.headers(), ...options.headers },
    })
    if (!res.ok) {
      if (res.status === 401) this.onUnauthorized?.()
      const body = await res.json().catch(() => ({ detail: res.statusText }))
      const err: ApiError = new Error(typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail))
      err.status = res.status
      err.body = body.detail
      throw err
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  // Health
  async health(): Promise<{ status: string; version: string; projects: number; members: number }> {
    const res = await fetch(`${this.baseUrl}/health`)
    if (!res.ok) throw new Error('Server unreachable')
    return res.json()
  }

  // Projects
  async listProjects(): Promise<Project[]> {
    return this.request('/projects')
  }

  async createProject(name: string, description = '', color = '#E04E0E'): Promise<Project> {
    return this.request('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, color }),
    })
  }

  async updateProject(projectId: number, updates: Partial<Pick<Project, 'name' | 'description' | 'color'>>): Promise<Project> {
    return this.request(`/projects/${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
  }

  async getProject(projectId: number): Promise<Project & { files: FileEntry[] }> {
    return this.request(`/projects/${projectId}`)
  }

  async deleteProject(projectId: number): Promise<{ ok: boolean }> {
    return this.request(`/projects/${projectId}`, { method: 'DELETE' })
  }

  // Members
  async listMembers(): Promise<Member[]> {
    return this.request('/members')
  }

  async createMember(name: string, email = '', avatarColor = '#0B7268'): Promise<Member> {
    return this.request('/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, avatar_color: avatarColor }),
    })
  }

  async deleteMember(memberId: number): Promise<{ ok: boolean }> {
    return this.request(`/members/${memberId}`, { method: 'DELETE' })
  }

  // Files
  async listFiles(projectId: number): Promise<FileEntry[]> {
    return this.request(`/projects/${projectId}/files`)
  }

  async uploadFile(
    projectId: number,
    path: string,
    file: File | Blob,
    baseVersion = 0,
    message = '',
    force = false,
  ): Promise<FileEntry> {
    const params = new URLSearchParams({
      path,
      message,
      base_version: String(baseVersion),
      force: String(force),
    })
    const formData = new FormData()
    formData.append('file', file)
    return this.request(`/projects/${projectId}/files/upload?${params}`, {
      method: 'POST',
      body: formData,
    })
  }

  async downloadFile(projectId: number, path: string, version?: number): Promise<Blob> {
    const params = new URLSearchParams({ path })
    if (version !== undefined) params.set('version', String(version))
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/files/download?${params}`, {
      headers: this.headers(),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail))
    }
    const blob = await res.blob()
    // Server always returns at least the file's bytes; an empty response indicates a corrupted blob.
    if (blob.size === 0) {
      throw new Error('Downloaded file is empty — the version blob may be corrupted on the server')
    }
    return blob
  }

  async lockFile(projectId: number, path: string, reason = '', also: string[] = []): Promise<LockResult> {
    return this.request(`/projects/${projectId}/files/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, reason, also }),
    })
  }

  async unlockFile(projectId: number, path: string, scope: 'file' | 'group' = 'file'): Promise<FileEntry> {
    return this.request(`/projects/${projectId}/files/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, scope }),
    })
  }

  async revertFile(projectId: number, path: string, version: number): Promise<FileEntry> {
    return this.request(`/projects/${projectId}/files/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, version }),
    })
  }

  async listVersions(projectId: number, path: string): Promise<Version[]> {
    const params = new URLSearchParams({ path })
    return this.request(`/projects/${projectId}/files/versions?${params}`)
  }

  async deleteFile(projectId: number, path: string): Promise<{ ok: boolean }> {
    const params = new URLSearchParams({ path })
    return this.request(`/projects/${projectId}/files?${params}`, { method: 'DELETE' })
  }

  // Activity
  async listActivity(projectId: number, limit = 50, offset = 0): Promise<Activity[]> {
    return this.request(`/projects/${projectId}/activity?limit=${limit}&offset=${offset}`)
  }

  // Ignore patterns — single source of truth, mirrored into the native scan
  async getIgnorePatterns(): Promise<string[]> {
    const res = await this.request<{ patterns: string[] }>('/ignore-patterns')
    return res.patterns
  }

  // Extra ignore rules applied only when the client detects a Unity project.
  async getUnityIgnorePatterns(): Promise<string[]> {
    const res = await this.request<{ patterns: string[] }>('/unity-ignore-patterns')
    return res.patterns
  }

  // Related Unity files to offer when locking `path` (meta, prefab/mat, GUID refs).
  async lockSuggestions(projectId: number, path: string): Promise<LockSuggestionResult> {
    return this.request(`/projects/${projectId}/files/lock-suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  }

  // Compare — client posts a manifest of its local folder (each entry carries the
  // client's sync base) and the server diffs against the DB. Push/pull are
  // orchestrated client-side (see useFileWatch) via per-file upload/download.
  async compareProject(
    projectId: number,
    manifest: CompareManifestEntry[],
    tombstones: CompareTombstone[] = [],
  ): Promise<CompareResult> {
    return this.request(`/projects/${projectId}/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: manifest, tombstones }),
    })
  }

  // Server settings
  async getSettings(): Promise<ServerSettings> {
    return this.request('/settings')
  }

  async updateSettings(updates: Partial<ServerSettings>): Promise<ServerSettings> {
    return this.request('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
  }
}
