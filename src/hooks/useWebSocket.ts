import { useState, useEffect, useRef } from 'react'
import { CrowSyncWebSocket } from '../api/websocket'
import type { SyncEvent } from '../types'

const eventKey = (e: SyncEvent) => `${e.at}|${e.event}|${e.data?.path ?? ''}|${e.data?.member ?? ''}`

export function useCrowSyncWebSocket(
  serverUrl: string,
  projectId: number | null,
  memberName: string,
  apiKey = '',
) {
  const wsRef = useRef<CrowSyncWebSocket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [events, setEvents] = useState<SyncEvent[]>([])

  useEffect(() => {
    if (!serverUrl || !projectId || !memberName) {
      setIsConnected(false)
      setEvents([])
      return
    }

    // Reset event log when project changes — stale events from previous project would be misleading.
    setEvents([])

    const ws = new CrowSyncWebSocket()
    wsRef.current = ws

    const unsub = ws.onAny((event: SyncEvent) => {
      setEvents(prev => {
        const key = eventKey(event)
        if (prev.some(e => eventKey(e) === key)) return prev
        return [event, ...prev].slice(0, 100)
      })
    })

    ws.connect(serverUrl, projectId, memberName, apiKey)

    const checkInterval = setInterval(() => {
      setIsConnected(ws.isConnected)
    }, 1000)

    return () => {
      unsub()
      clearInterval(checkInterval)
      ws.disconnect()
      wsRef.current = null
    }
  }, [serverUrl, projectId, memberName, apiKey])

  return { ws: wsRef.current, isConnected, events }
}
