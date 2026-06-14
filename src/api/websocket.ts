import type { SyncEvent } from '../types'

type EventHandler = (event: SyncEvent) => void

export class CrowSyncWebSocket {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<EventHandler>>()
  private globalListeners = new Set<EventHandler>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private projectId: number | null = null
  private serverUrl: string = ''
  private memberName: string = ''
  private apiKey: string = ''
  private pingInterval: ReturnType<typeof setInterval> | null = null

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(serverUrl: string, projectId: number, memberName: string, apiKey = ''): void {
    this.disconnect()
    this.serverUrl = serverUrl
    this.projectId = projectId
    this.memberName = memberName
    this.apiKey = apiKey
    this.reconnectDelay = 1000
    this._connect()
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
    this.projectId = null
  }

  on(eventType: string, handler: EventHandler): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set())
    }
    this.listeners.get(eventType)!.add(handler)
    return () => this.listeners.get(eventType)?.delete(handler)
  }

  onAny(handler: EventHandler): () => void {
    this.globalListeners.add(handler)
    return () => this.globalListeners.delete(handler)
  }

  private _connect(): void {
    const wsUrl = this.serverUrl.replace(/^http/, 'ws')
    // No credentials in the URL — auth is sent as the first message after open,
    // so the API key never leaks into server/proxy access logs (S2).
    this.ws = new WebSocket(`${wsUrl}/projects/${this.projectId}/ws`)

    this.ws.onopen = () => {
      this.reconnectDelay = 1000
      this.ws?.send(JSON.stringify({
        type: 'auth', member_name: this.memberName, api_key: this.apiKey,
      }))
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30000)
    }

    this.ws.onmessage = (e) => {
      try {
        const event: SyncEvent = JSON.parse(e.data)
        if ((event as { type?: string }).type === 'pong') return

        const handlers = this.listeners.get(event.event)
        if (handlers) {
          handlers.forEach(h => h(event))
        }
        this.globalListeners.forEach(h => h(event))
      } catch {
        // ignore malformed messages
      }
    }

    this.ws.onclose = () => {
      if (this.pingInterval) {
        clearInterval(this.pingInterval)
        this.pingInterval = null
      }
      this._reconnect()
    }

    this.ws.onerror = () => {
      // onerror is always followed by onclose
    }
  }

  private _reconnect(): void {
    if (!this.projectId) return
    this.reconnectTimer = setTimeout(() => {
      this._connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
  }
}
