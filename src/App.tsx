import { useState, useEffect, useCallback } from 'react'
import { CrowSyncClient } from './api/client'
import { pickFolder } from './utils/folderPicker'
import { SyncPage } from './pages/SyncPage'
import './index.css'

function App() {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('crowsync_server_url') || 'http://localhost:8001')
  const [memberName, setMemberName] = useState(() => localStorage.getItem('crowsync_member_name') || '')
  const [memberId, setMemberId] = useState<number | null>(() => {
    const stored = localStorage.getItem('crowsync_member_id')
    return stored ? Number(stored) : null
  })
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('crowsync_api_key') || '')
  const [showSetup, setShowSetup] = useState(!memberName)
  const [showSettings, setShowSettings] = useState(false)
  const [client, setClient] = useState<CrowSyncClient | null>(null)
  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  // null = unknown yet; true = server lets anyone register with just a name (open LAN /
  // bootstrap), so we hide the admin-token field. Probed from /health.
  const [openRegistration, setOpenRegistration] = useState<boolean | null>(null)

  const [formUrl, setFormUrl] = useState(serverUrl)
  const [formName, setFormName] = useState(memberName)
  const [formAdminToken, setFormAdminToken] = useState(() => localStorage.getItem('crowsync_admin_token') || '')
  const [formApiKey, setFormApiKey] = useState('')
  const [setupError, setSetupError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [formStorageRoot, setFormStorageRoot] = useState('')
  const [formAutoUnlock, setFormAutoUnlock] = useState('')
  const [formMaxFileSize, setFormMaxFileSize] = useState('')
  const [ignoreRules, setIgnoreRules] = useState<string[]>([])
  const [unityRules, setUnityRules] = useState<string[]>([])

  // Client-side preferences
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    (localStorage.getItem('crowsync_theme') as 'light' | 'dark') || 'light'
  )
  const [syncInterval, setSyncInterval] = useState<number>(() => {
    const stored = localStorage.getItem('crowsync_sync_interval')
    return stored !== null ? Number(stored) : 5000
  })

  // Form state for settings (client prefs)
  const [formTheme, setFormTheme] = useState<'light' | 'dark'>(theme)
  const [formSyncInterval, setFormSyncInterval] = useState<string>(String(syncInterval))
  const [formSettingsAdminToken, setFormSettingsAdminToken] = useState('')

  // Apply theme to <html>
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // A 401 on an authenticated call means the stored session is stale (the server
  // doesn't recognize this member/key — e.g. the DB was reset). Drop the key and
  // return to setup with an explanation instead of failing silently on every call.
  const handleUnauthorized = useCallback(() => {
    localStorage.removeItem('crowsync_api_key')
    localStorage.removeItem('crowsync_member_id')
    setApiKey('')
    setMemberId(null)
    setSetupError('The server no longer recognizes this session. Reconnect to re-register, or paste your existing API key.')
    setShowSetup(true)
  }, [])

  useEffect(() => {
    if (serverUrl && memberName) {
      setClient(new CrowSyncClient(serverUrl, memberName, apiKey, handleUnauthorized))
    } else {
      setClient(null)
    }
  }, [serverUrl, memberName, apiKey, handleUnauthorized])

  // Sync the settings form from live client-side values when the panel opens.
  useEffect(() => {
    if (!showSettings) return
    setFormTheme(theme)
    setFormSyncInterval(String(syncInterval))
    setFormSettingsAdminToken(localStorage.getItem('crowsync_admin_token') || '')
  }, [showSettings, theme, syncInterval])

  // Fetch server-side settings + ignore rules when the panel opens. Kept separate
  // from the form-sync above so changing theme/interval doesn't refetch them.
  useEffect(() => {
    if (!showSettings || !client) return
    client.getSettings().then(s => {
      setFormStorageRoot(s.storage_root)
      setFormAutoUnlock(s.auto_unlock_hours)
      setFormMaxFileSize(s.max_file_size_mb)
    }).catch(() => {})
    client.getIgnorePatterns().then(setIgnoreRules).catch(() => {})
    client.getUnityIgnorePatterns().then(setUnityRules).catch(() => {})
  }, [showSettings, client])

  const testConnection = useCallback(async () => {
    setTestResult('testing')
    try {
      const c = new CrowSyncClient(formUrl, formName)
      const h = await c.health()
      setOpenRegistration(!!h.open_registration)
      setTestResult('ok')
    } catch {
      setOpenRegistration(null)
      setTestResult('fail')
    }
  }, [formUrl, formName])

  // Probe the server once the setup screen opens (or the URL settles) so the
  // admin-token field can hide itself in open-LAN / bootstrap mode. Debounced so
  // typing the URL doesn't fire a request per keystroke; the member name is
  // irrelevant to /health, so it's not a dependency.
  useEffect(() => {
    if (!showSetup || !formUrl) return
    let cancelled = false
    const t = setTimeout(() => {
      new CrowSyncClient(formUrl, '').health()
        .then(h => { if (!cancelled) setOpenRegistration(!!h.open_registration) })
        .catch(() => { if (!cancelled) setOpenRegistration(null) })
    }, 400)
    return () => { cancelled = true; clearTimeout(t) }
  }, [showSetup, formUrl])

  // Commit the connection (server + name + key) to localStorage and app state.
  const commitSession = useCallback((url: string, name: string, key: string, id: number | null) => {
    localStorage.setItem('crowsync_server_url', url)
    localStorage.setItem('crowsync_member_name', name)
    if (key) localStorage.setItem('crowsync_api_key', key)
    if (id !== null) localStorage.setItem('crowsync_member_id', String(id))
    setServerUrl(url)
    setMemberName(name)
    setApiKey(key)
    setMemberId(id)
    setShowSetup(false)
  }, [])

  const handleSetup = useCallback(async () => {
    const name = formName.trim()
    if (!name || !formUrl) return
    setSetupError('')

    // Recovery path: a known API key was pasted (new machine) — trust it and
    // skip registration. The key is validated on the first authenticated call.
    const pastedKey = formApiKey.trim()
    if (pastedKey) {
      commitSession(formUrl, name, pastedKey, null)
      return
    }

    setConnecting(true)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Member-Name': name }
      const adminToken = formAdminToken.trim()
      if (adminToken) {
        headers['X-Admin-Token'] = adminToken
        localStorage.setItem('crowsync_admin_token', adminToken)
      }
      const res = await fetch(`${formUrl}/members`, {
        method: 'POST', headers, body: JSON.stringify({ name }),
      })
      if (res.ok) {
        const member = await res.json()
        commitSession(formUrl, name, member.api_key || '', typeof member.id === 'number' ? member.id : null)
        return
      }
      // Surface the failure instead of leaving a half-connected session (V3).
      const body = await res.json().catch(() => null)
      const detail = typeof body?.detail === 'string' ? body.detail : ''
      if (res.status === 403) {
        setSetupError(detail || 'Registration needs a valid admin token. Ask an admin, or paste your existing API key to recover.')
      } else {
        setSetupError(detail || `Registration failed (HTTP ${res.status})`)
      }
    } catch {
      setSetupError('Server unreachable. Check the address and try again.')
    } finally {
      setConnecting(false)
    }
  }, [formUrl, formName, formAdminToken, formApiKey, commitSession])

  const saveServerSettings = useCallback(async () => {
    if (!client) return
    // Save client-side preferences
    localStorage.setItem('crowsync_theme', formTheme)
    setTheme(formTheme)
    const interval = Number(formSyncInterval)
    localStorage.setItem('crowsync_sync_interval', String(interval))
    setSyncInterval(interval)
    if (formSettingsAdminToken.trim()) {
      localStorage.setItem('crowsync_admin_token', formSettingsAdminToken.trim())
    } else {
      localStorage.removeItem('crowsync_admin_token')
    }
    // Save server settings
    try {
      await client.updateSettings({
        storage_root: formStorageRoot,
        auto_unlock_hours: formAutoUnlock,
        max_file_size_mb: formMaxFileSize,
      })
    } catch { /* ignore */ }
    setShowSettings(false)
  }, [client, formStorageRoot, formAutoUnlock, formMaxFileSize, formTheme, formSyncInterval, formSettingsAdminToken])

  // ── Setup ─────────────────────────────────────────────────────────
  if (showSetup) {
    return (
      <div className="h-screen bg-surface-0 scanlines flex items-center justify-center">
        <div className="w-[360px] animate-riso-fade-up">
          <div className="flex items-center gap-2 mb-8">
            <span className="text-accent font-bold text-lg font-mono" style={{ textShadow: '1px 1px 0px var(--color-sync)' }}>CS</span>
            <span className="text-text-primary font-semibold tracking-wide">CrowSync</span>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Name</label>
              <input
                type="text" value={formName}
                onChange={e => setFormName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSetup()}
                placeholder="Your name"
                className="input-riso w-full rounded px-3 py-2 text-sm text-text-primary placeholder-text-ghost"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Server</label>
              <input
                type="text" value={formUrl}
                onChange={e => setFormUrl(e.target.value)}
                placeholder="http://192.168.1.101:8001"
                className="input-riso w-full rounded px-3 py-2 text-sm text-text-primary font-mono placeholder-text-ghost"
              />
            </div>

            <div className="flex gap-2 items-center">
              <button onClick={testConnection}
                className="btn-riso btn-riso-secondary flex-1 text-xs py-2 rounded">
                {testResult === 'testing' ? 'Testing...' : 'Test'}
              </button>
              {testResult === 'ok' && <span className="text-sync text-xs font-mono font-bold">OK</span>}
              {testResult === 'fail' && <span className="text-danger text-xs font-mono font-bold">FAIL</span>}
            </div>

            {openRegistration ? (
              <p className="text-[13px] text-sync bg-surface-1 border border-sync/30 rounded px-3 py-2">
                Open LAN mode — just enter a name and connect. No token needed.
              </p>
            ) : (
              <div>
                <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Admin token <span className="text-text-ghost normal-case font-normal">— only for new members after the first</span></label>
                <input
                  type="password" value={formAdminToken}
                  onChange={e => setFormAdminToken(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSetup()}
                  placeholder="Leave empty for the first member"
                  className="input-riso w-full rounded px-3 py-2 text-sm text-text-primary font-mono placeholder-text-ghost"
                />
              </div>
            )}

            <div>
              <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">API key <span className="text-text-ghost normal-case font-normal">— recovery on a new machine</span></label>
              <input
                type="password" value={formApiKey}
                onChange={e => setFormApiKey(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSetup()}
                placeholder="Paste an existing key to reconnect"
                className="input-riso w-full rounded px-3 py-2 text-sm text-text-primary font-mono placeholder-text-ghost"
              />
            </div>

            {setupError && (
              <p className="text-[13px] text-danger bg-danger-muted border border-danger/30 rounded px-3 py-2 animate-riso-fade-up"
                style={{ boxShadow: '2px 2px 0px var(--color-danger)' }}>
                {setupError}
              </p>
            )}

            <button onClick={handleSetup} disabled={!formUrl || !formName.trim() || connecting}
              className="btn-riso btn-riso-primary w-full text-sm py-2.5 rounded">
              {connecting ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Settings ──────────────────────────────────────────────────────
  if (showSettings) {
    return (
      <div className="h-screen bg-surface-0 scanlines overflow-y-auto flex items-start justify-center py-10">
        <div className="w-[420px] animate-riso-fade-up">
          <div className="flex items-center gap-2 mb-6">
            <span className="text-accent font-bold text-lg font-mono" style={{ textShadow: '1px 1px 0px var(--color-sync)' }}>CS</span>
            <span className="text-text-primary font-semibold tracking-wide">Settings</span>
          </div>

          <div className="space-y-5">

            {/* ── Session info ── */}
            <div className="card-riso rounded p-3 space-y-1">
              <div className="flex justify-between text-[13px]">
                <span className="text-text-muted font-mono tracking-widest">USER</span>
                <span className="text-text-primary font-medium">{memberName}</span>
              </div>
              <div className="flex justify-between text-[13px]">
                <span className="text-text-muted font-mono tracking-widest">SERVER</span>
                <span className="text-text-secondary font-mono text-right truncate max-w-[220px]">{serverUrl}</span>
              </div>
              {apiKey && (
                <div className="flex justify-between text-[13px]">
                  <span className="text-text-muted font-mono tracking-widest">API KEY</span>
                  <span className="text-text-secondary font-mono">{apiKey.slice(0, 8)}…</span>
                </div>
              )}
            </div>

            {/* ── Appearance ── */}
            <div>
              <p className="text-[11px] font-mono font-bold text-text-muted uppercase tracking-widest mb-2">Appearance</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setFormTheme('light')}
                  className={`btn-riso flex-1 text-[13px] py-2 rounded gap-1.5 ${formTheme === 'light' ? 'btn-riso-primary' : 'btn-riso-secondary'}`}>
                  ☀ Light
                </button>
                <button
                  onClick={() => setFormTheme('dark')}
                  className={`btn-riso flex-1 text-[13px] py-2 rounded gap-1.5 ${formTheme === 'dark' ? 'btn-riso-primary' : 'btn-riso-secondary'}`}>
                  ☾ Dark
                </button>
              </div>
            </div>

            {/* ── Sync ── */}
            <div>
              <p className="text-[11px] font-mono font-bold text-text-muted uppercase tracking-widest mb-2">Sync</p>
              <div>
                <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Poll interval</label>
                <div className="flex gap-1.5">
                  {[
                    { label: '5s', value: '5000' },
                    { label: '15s', value: '15000' },
                    { label: '30s', value: '30000' },
                    { label: '60s', value: '60000' },
                    { label: 'Manual', value: '0' },
                  ].map(opt => (
                    <button key={opt.value}
                      onClick={() => setFormSyncInterval(opt.value)}
                      className={`btn-riso flex-1 text-[12px] py-1.5 rounded ${formSyncInterval === opt.value ? 'btn-riso-primary' : 'btn-riso-secondary'}`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[12px] text-text-ghost mt-1">
                  {formSyncInterval === '0'
                    ? 'Auto-scan off — scan runs only when you click Sync'
                    : 'How often the desktop app scans and hashes files on disk'}
                </p>
              </div>
            </div>

            {/* ── Admin ── */}
            <div>
              <p className="text-[11px] font-mono font-bold text-text-muted uppercase tracking-widest mb-2">Admin</p>
              <div>
                <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Admin token</label>
                <input type="password" value={formSettingsAdminToken}
                  onChange={e => setFormSettingsAdminToken(e.target.value)}
                  placeholder="Leave empty to clear stored token"
                  className="input-riso w-full rounded px-3 py-1.5 text-[14px] text-text-primary font-mono placeholder-text-ghost"
                />
                <p className="text-[12px] text-text-ghost mt-1">Required to register members and change server settings</p>
              </div>
            </div>

            {/* ── Server settings (admin) ── */}
            <div>
              <p className="text-[11px] font-mono font-bold text-text-muted uppercase tracking-widest mb-2">Server <span className="text-text-ghost normal-case font-normal">(admin only)</span></p>
              <div className="space-y-3">
                <div>
                  <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Storage path</label>
                  <div className="flex gap-1.5">
                    <input type="text" value={formStorageRoot}
                      onChange={e => setFormStorageRoot(e.target.value)}
                      placeholder="D:\server\ or \\server01\crowsync"
                      className="input-riso flex-1 rounded px-3 py-1.5 text-[14px] text-text-primary font-mono placeholder-text-ghost"
                    />
                    <button type="button"
                      onClick={async () => { const p = await pickFolder('Select storage folder'); if (p) setFormStorageRoot(p) }}
                      className="btn-riso btn-riso-secondary text-[13px] px-3 rounded shrink-0">
                      ...
                    </button>
                  </div>
                  <p className="text-[12px] text-text-ghost mt-1">Where server stores versioned files</p>
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Auto-unlock (h)</label>
                    <input type="number" min="1" value={formAutoUnlock}
                      onChange={e => setFormAutoUnlock(e.target.value)}
                      placeholder="24"
                      className="input-riso w-full rounded px-3 py-1.5 text-[14px] text-text-primary font-mono placeholder-text-ghost"
                    />
                    <p className="text-[12px] text-text-ghost mt-1">Release stale locks after</p>
                  </div>
                  <div className="flex-1">
                    <label className="block text-[12px] font-mono font-bold text-text-muted uppercase tracking-widest mb-1.5">Max file (MB)</label>
                    <input type="number" min="1" value={formMaxFileSize}
                      onChange={e => setFormMaxFileSize(e.target.value)}
                      placeholder="2048"
                      className="input-riso w-full rounded px-3 py-1.5 text-[14px] text-text-primary font-mono placeholder-text-ghost"
                    />
                    <p className="text-[12px] text-text-ghost mt-1">Upload size limit</p>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Ignore rules (read-only) ── */}
            <div>
              <p className="text-[11px] font-mono font-bold text-text-muted uppercase tracking-widest mb-2">Ignore rules</p>
              <div className="card-riso rounded p-2 max-h-36 overflow-y-auto space-y-2">
                <div>
                  <p className="text-[11px] text-text-ghost font-mono mb-1">Default</p>
                  <div className="flex flex-wrap gap-1">
                    {ignoreRules.map(r => (
                      <span key={r} className="text-[11px] font-mono text-text-secondary bg-surface-3 px-1.5 py-px rounded">{r}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-[11px] text-text-ghost font-mono mb-1">Unity <span className="text-sync">(active on Unity projects)</span></p>
                  <div className="flex flex-wrap gap-1">
                    {unityRules.map(r => (
                      <span key={r} className="text-[11px] font-mono text-text-secondary bg-surface-3 px-1.5 py-px rounded">{r}</span>
                    ))}
                  </div>
                </div>
              </div>
              <p className="text-[12px] text-text-ghost mt-1">Hardcoded for now; per-project additions via <span className="font-mono">.crowsyncignore</span></p>
            </div>

            {/* ── Save / Cancel ── */}
            <div className="flex gap-2 pt-1">
              <button onClick={saveServerSettings}
                className="btn-riso btn-riso-primary flex-1 text-xs py-2 rounded">
                Save
              </button>
              <button onClick={() => setShowSettings(false)}
                className="btn-riso btn-riso-secondary flex-1 text-xs py-2 rounded">
                Cancel
              </button>
            </div>

            {/* ── Danger zone ── */}
            <div className="border border-danger/40 rounded p-3 space-y-2" style={{ boxShadow: '3px 3px 0px var(--color-danger)' }}>
              <p className="text-[11px] font-mono font-bold text-danger uppercase tracking-widest">Danger zone</p>
              <p className="text-[12px] text-text-muted">Clears all local session data (server URL, name, API key). You will need to reconnect.</p>
              <button
                onClick={() => {
                  localStorage.clear()
                  setMemberName(''); setServerUrl('http://localhost:8001')
                  setClient(null); setShowSettings(false); setShowSetup(true)
                }}
                className="btn-riso btn-riso-danger w-full text-[13px] py-2 rounded">
                Disconnect &amp; reset
              </button>
            </div>

          </div>
        </div>
      </div>
    )
  }

  if (!client) {
    return (
      <div className="h-screen bg-surface-0 scanlines flex items-center justify-center text-text-ghost font-mono text-xs">
        Loading...
      </div>
    )
  }

  return (
    <SyncPage
      client={client}
      serverUrl={serverUrl}
      memberName={memberName}
      apiKey={apiKey}
      currentMemberId={memberId}
      syncInterval={syncInterval}
      onSettings={() => setShowSettings(true)}
    />
  )
}

export default App
