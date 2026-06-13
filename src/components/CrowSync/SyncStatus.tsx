interface SyncStatusProps {
  isOnline: boolean
  serverVersion: string
}

export function SyncStatus({ isOnline, serverVersion }: SyncStatusProps) {
  return (
    <div className="flex items-center gap-2 font-mono text-xs">
      <div
        className={`w-1.5 h-1.5 rounded-full ${
          isOnline ? 'bg-sync glow-sync' : 'bg-danger glow-danger'
        }`}
      />
      <span className={isOnline ? 'text-sync' : 'text-danger'}>
        {isOnline ? 'ONLINE' : 'OFFLINE'}
      </span>
      {isOnline && serverVersion && (
        <span className="text-text-muted">{serverVersion}</span>
      )}
    </div>
  )
}
