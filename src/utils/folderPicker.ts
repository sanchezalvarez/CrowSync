/**
 * Native folder picker using Tauri dialog plugin.
 * Falls back to prompt() in browser dev mode.
 */
export async function pickFolder(title = 'Select folder'): Promise<string | null> {
  try {
    // Try Tauri native dialog
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: true,
      multiple: false,
      title,
    })
    return selected as string | null
  } catch {
    // Fallback for browser dev mode — prompt for path
    const path = window.prompt(title + '\n\nEnter folder path:')
    return path || null
  }
}
