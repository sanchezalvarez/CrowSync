import { useState, useEffect, useCallback } from 'react'
import type { CrowSyncClient } from '../api/client'

export function useSyncStatus(client: CrowSyncClient | null) {
  const [isOnline, setIsOnline] = useState(false)
  const [serverVersion, setServerVersion] = useState('')

  const check = useCallback(async () => {
    if (!client) {
      setIsOnline(false)
      return
    }
    try {
      const health = await client.health()
      setIsOnline(health.status === 'ok')
      setServerVersion(health.version)
    } catch {
      setIsOnline(false)
    }
  }, [client])

  useEffect(() => {
    // Kick off the initial health probe; `check` only sets state after its await
    // (or in the no-client guard), so the cascading-render concern doesn't apply.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    check()
    const interval = setInterval(check, 30000)
    return () => clearInterval(interval)
  }, [check])

  return { isOnline, serverVersion, check }
}
