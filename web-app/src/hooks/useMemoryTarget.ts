import { useEffect, useMemo, useState } from 'react'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useMemoryConversations } from '@/hooks/useMemoryConversations'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { memoryLocation } from '@/lib/memoryBinding'
import type { MemoryLocation } from '@janhq/tauri-plugin-agent-tools-api'

/**
 * What the memory page is looking at: the data folder, the conversation and
 * project folder the user picked, the Flint project, and the backend location
 * those make. The backend derives what may be seen from the location; the page
 * cannot widen it by asking differently.
 */
export function useMemoryTarget() {
  /**
   * Where the settings page is. Deliberately not a project or session the page
   * chooses: the backend derives what may be seen from this, and the page
   * cannot widen it by asking differently.
   */
  /**
   * Resolved from the service hub, which is the only thing that knows it.
   *
   * This read `window.core?.api?.dataFolder`, which nothing in the application
   * defines -- it was the sole reference to that path anywhere. It resolved to
   * `''`, the backend's `settings_root()` returned `None`, and every command on
   * this page rejected with "no data folder to store settings in". The toggle
   * was simply the first one anybody pressed.
   *
   * `null` while it is being fetched, so the page can tell "not loaded yet"
   * apart from "loaded and empty" instead of sending a request that cannot
   * succeed.
   */
  const [dataFolder, setDataFolder] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getServiceHub()
      .app()
      .getJanDataFolder()
      .then((folder) => {
        if (!cancelled) setDataFolder(folder ?? '')
      })
      .catch(() => {
        if (!cancelled) setDataFolder('')
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Which conversation and which project the chat/project tabs are about.
   *
   * This read `window.core.api.activeSessionId` and `.projectRoot`, which
   * nothing in the application ever assigns, so "This chat" and "This
   * project" always answered "no chat is open". The user picks them here from
   * the conversations and project folders that exist; the backend still
   * derives the project's identity from the folder itself and never trusts an
   * id the page sends.
   */
  const conversations = useMemoryConversations()
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [projectRoot, setProjectRoot] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (sessionId === undefined && conversations.sessions[0]) {
      setSessionId(conversations.sessions[0].id)
    }
    if (projectRoot === undefined && conversations.projects[0]) {
      setProjectRoot(conversations.projects[0])
    }
  }, [conversations, sessionId, projectRoot])

  /**
   * The Flint project whose memories the Project tab shows, for a project with
   * no folder. The backend scopes it (`jan-project:<id>`) and shows that
   * project's records and no other's. A folder, when one is picked, is the
   * identity instead, so choosing one of these clears the other.
   */
  const projects = useThreadManagement((s) => s.folders)
  const [projectId, setProjectId] = useState('')
  const selectedProject = projects.find((p) => p.id === projectId)
  useEffect(() => {
    // A project deleted while selected is no longer a scope to show.
    if (projectId && !projects.some((p) => p.id === projectId)) setProjectId('')
  }, [projects, projectId])

  const location: MemoryLocation | null = useMemo(
    () =>
      dataFolder == null
        ? null
        : memoryLocation(
            dataFolder,
            {
              projectRoot: projectRoot || undefined,
              janProjectId: projectId || undefined,
            },
            sessionId
          ),
    [dataFolder, projectRoot, projectId, sessionId]
  )

  return {
    dataFolder,
    conversations,
    sessionId,
    setSessionId,
    projectRoot,
    setProjectRoot,
    projects,
    projectId,
    setProjectId,
    selectedProject,
    location,
  }
}
