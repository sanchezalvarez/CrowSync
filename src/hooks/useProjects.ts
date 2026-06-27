import { useState, useEffect, useCallback } from 'react'
import type { Project } from '../types'
import type { CrowSyncClient } from '../api/client'

export function useProjects(client: CrowSyncClient | null) {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const stored = localStorage.getItem('crowsync_selected_project')
    return stored ? Number(stored) : null
  })
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!client) return
    setLoading(true)
    try {
      const list = await client.listProjects()
      setProjects(list)
    } catch {
      // offline or error
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => { refresh() }, [refresh])

  const select = useCallback((id: number | null) => {
    setSelectedId(id)
    if (id !== null) {
      localStorage.setItem('crowsync_selected_project', String(id))
    } else {
      localStorage.removeItem('crowsync_selected_project')
    }
  }, [])

  const createProject = useCallback(async (name: string, description = '', color = '#E04E0E') => {
    if (!client) return
    // No path: the server ignores project.root_path (distributed model). The
    // member's local working folder is chosen later in Init, per machine.
    const project = await client.createProject(name, description, color)
    setProjects(prev => [project, ...prev])
    select(project.id)
    return project
  }, [client, select])

  const deleteProject = useCallback(async (id: number) => {
    if (!client) return
    try {
      await client.deleteProject(id)
      setProjects(prev => prev.filter(p => p.id !== id))
      if (selectedId === id) select(null)
    } catch (e) {
      // e.g. 403 if the caller isn't a project admin — leave the list untouched
      // and surface the reason rather than crashing the panel.
      alert(e instanceof Error ? e.message : 'Failed to delete project')
    }
  }, [client, selectedId, select])

  const selected = projects.find(p => p.id === selectedId) ?? null

  return { projects, selected, selectedId, select, loading, refresh, createProject, deleteProject }
}
