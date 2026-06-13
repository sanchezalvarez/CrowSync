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
    check()
    const interval = setInterval(check, 30000)
    return () => clearInterval(interval)
  }, [check])

  return { isOnline, serverVersion, check }
}
