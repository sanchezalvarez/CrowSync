import type { CrowSyncClient } from '../api/client'
import { detectUnity } from './nativeFs'

/**
 * Resolve the ignore patterns for scanning a local folder: the base set, plus
 * the Unity extras (Library/, *.csproj…) when the folder is a Unity project.
 *
 * Shared by both scan entry points — `useFileWatch.compare()` (the 5s poll) and
 * `InitProjectDialog.handleScan()` (the import) — so they can never drift. The
 * base/Unity lists are effectively static server-side, so they're fetched once
 * and memoized for the rest of the session (matches the old per-hook caching,
 * now shared across call sites).
 */
let basePatterns: string[] | null = null
let unityPatterns: string[] | null = null

async function getBase(client: CrowSyncClient): Promise<string[]> {
  if (basePatterns) return basePatterns
  try {
    return (basePatterns = await client.getIgnorePatterns())
  } catch {
    return [] // don't cache the failure — retry on the next scan
  }
}

async function getUnity(client: CrowSyncClient): Promise<string[]> {
  if (unityPatterns) return unityPatterns
  try {
    return (unityPatterns = await client.getUnityIgnorePatterns())
  } catch {
    return []
  }
}

export async function resolveScanPatterns(
  client: CrowSyncClient,
  localPath: string,
): Promise<{ patterns: string[]; isUnity: boolean }> {
  // Base patterns and Unity detection are independent — overlap them.
  const [base, isUnity] = await Promise.all([getBase(client), detectUnity(localPath)])
  if (!isUnity) return { patterns: base, isUnity }
  return { patterns: [...base, ...await getUnity(client)], isUnity }
}
