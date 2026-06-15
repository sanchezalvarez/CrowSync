/**
 * Bridge to the native (Rust/Tauri) filesystem + transfer commands.
 *
 * These only exist in the Tauri desktop build. In browser dev mode the import
 * fails and `isNativeAvailable()` returns false, so callers degrade to read-only
 * (no scan/push/pull) — mirroring the fallback pattern in `folderPicker.ts`.
 */
import type { ApiBody, ManifestEntry } from '../types'

async function getInvoke() {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke
  } catch {
    return null
  }
}

export function isNativeAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Outcome of a native HTTP transfer — mirrors Rust `TransferOutcome`.
 * `status` lets callers distinguish 423 (locked) / 409 (conflict) / 413 (too large). */
export interface TransferOutcome {
  ok: boolean
  status: number
  body?: ApiBody
}

/** Live scan progress streamed from the native scan_dir over a Tauri Channel. */
export interface ScanProgress {
  scanned: number
  current: string
}

export async function scanDir(
  root: string,
  ignorePatterns: string[],
  onProgress?: (p: ScanProgress) => void,
): Promise<ManifestEntry[]> {
  // Channel lives in the same module as invoke, so load core directly here.
  const core = await import('@tauri-apps/api/core').catch(() => null)
  if (!core) throw new Error('Native scan unavailable (browser mode)')
  // The Rust command always expects the channel; without a callback its
  // messages are simply dropped.
  const channel = new core.Channel<ScanProgress>()
  if (onProgress) channel.onmessage = onProgress
  return core.invoke('scan_dir', { root, ignorePatterns, onProgress: channel })
}

/** True if the local folder is a Unity project (has Assets/ + ProjectSettings/).
 * Returns false in browser mode (no native access). */
export async function detectUnity(root: string): Promise<boolean> {
  const invoke = await getInvoke()
  if (!invoke) return false
  try {
    return await invoke<boolean>('detect_unity', { root })
  } catch {
    return false
  }
}

export interface UploadArgs {
  serverUrl: string
  memberName: string
  apiKey: string
  projectId: number
  relPath: string
  absPath: string
  baseVersion: number
  message: string
  force: boolean
  /** Stable upload id for resumable transfers — lets a killed upload resume from
   * the server's last received byte instead of restarting (see uploadState.ts). */
  resumeId?: string
}

export async function nativeUpload(args: UploadArgs): Promise<TransferOutcome> {
  const invoke = await getInvoke()
  if (!invoke) throw new Error('Native upload unavailable (browser mode)')
  return invoke('upload_file', { ...args })
}

export interface DownloadArgs {
  serverUrl: string
  memberName: string
  apiKey: string
  projectId: number
  relPath: string
  destAbsPath: string
  version?: number
}

export async function nativeDownload(args: DownloadArgs): Promise<TransferOutcome> {
  const invoke = await getInvoke()
  if (!invoke) throw new Error('Native download unavailable (browser mode)')
  return invoke('download_file', { ...args })
}

/** Delete a local file (pulled remote delete). Returns false if it was already gone.
 * Throws in browser mode (no native access) — callers guard with isNativeAvailable. */
export async function nativeDeleteLocal(absPath: string): Promise<boolean> {
  const invoke = await getInvoke()
  if (!invoke) throw new Error('Native delete unavailable (browser mode)')
  return invoke<boolean>('delete_local', { absPath })
}
