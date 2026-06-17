import { useEffect, useState } from 'react'
import { isNativeAvailable } from '../utils/nativeFs'

/**
 * Custom window title bar for the Tauri desktop build. The native OS chrome is
 * disabled (`decorations: false` in tauri.conf.json) because it ignores the app's
 * riso theme (always light on Windows). This bar uses the theme tokens so it
 * follows light/dark, and carries the crow wordmark + window controls.
 *
 * Renders nothing in browser dev mode — there is no OS window to control there.
 */
export function TitleBar() {
  const native = isNativeAvailable()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!native) return
    let unlisten: (() => void) | undefined
    ;(async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      setMaximized(await win.isMaximized())
      // Keep the maximize/restore glyph in sync when the user resizes by hand.
      unlisten = await win.onResized(async () => setMaximized(await win.isMaximized()))
    })()
    return () => unlisten?.()
  }, [native])

  if (!native) return null

  const win = async () => (await import('@tauri-apps/api/window')).getCurrentWindow()

  return (
    <div
      data-tauri-drag-region
      className="h-8 shrink-0 flex items-center justify-between bg-surface-1 border-b border-border-active select-none"
      style={{ boxShadow: '0 1px 0 var(--color-border-active)' }}
    >
      {/* Brand — pointer-events-none so the whole strip stays draggable */}
      <div className="flex items-center gap-2 px-3 pointer-events-none">
        <img src="/crow.png" alt="" className="w-4 h-4" draggable={false} />
        <span className="text-[12px] font-mono font-bold text-text-primary tracking-widest uppercase">
          CrowSync
        </span>
      </div>

      {/* Window controls */}
      <div className="flex items-stretch h-full">
        <button
          onClick={async () => (await win()).minimize()}
          title="Minimize"
          className="w-11 h-full flex items-center justify-center text-text-muted hover:bg-surface-2 hover:text-text-primary transition-colors"
        >
          <span className="block w-2.5 h-px bg-current" />
        </button>
        <button
          onClick={async () => (await win()).toggleMaximize()}
          title={maximized ? 'Restore' : 'Maximize'}
          className="w-11 h-full flex items-center justify-center text-text-muted hover:bg-surface-2 hover:text-text-primary transition-colors"
        >
          <span className={`block w-2.5 h-2.5 border border-current ${maximized ? 'rounded-[1px]' : ''}`} />
        </button>
        <button
          onClick={async () => (await win()).close()}
          title="Close"
          className="w-11 h-full flex items-center justify-center text-text-muted hover:bg-danger hover:text-white transition-colors"
        >
          <span className="font-mono text-sm leading-none">{'✕'}</span>
        </button>
      </div>
    </div>
  )
}
