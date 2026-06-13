/**
 * Per-project local working-folder path.
 *
 * In the distributed model each member keeps their own local copy, so the path
 * is a client-side concern (not `project.root_path` on the server, which every
 * member would map differently). Stored in localStorage keyed by project id.
 */

const key = (projectId: number) => `crowsync_local_path_${projectId}`

export function getLocalPath(projectId: number): string {
  return localStorage.getItem(key(projectId)) || ''
}

export function setLocalPath(projectId: number, path: string): void {
  if (path) localStorage.setItem(key(projectId), path)
  else localStorage.removeItem(key(projectId))
}

/** Join a local root with a forward-slash relative path. Windows accepts forward
 * slashes, so we normalize to `/` and let the OS handle it. */
export function joinLocal(root: string, relPath: string): string {
  return `${root.replace(/[/\\]+$/, '')}/${relPath}`
}
