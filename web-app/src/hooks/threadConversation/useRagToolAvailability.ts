import { useEffect } from 'react'
import type { useChat } from '@/hooks/use-chat'
import { ExtensionTypeEnum, VectorDBExtension } from '@janhq/core'
import { useAttachments } from '@/hooks/useAttachments'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { ExtensionManager } from '@/lib/extension'
import { warnIfProjectFilesChanged } from '@/lib/projectFileFreshness'

/**
 * Tells the chat whether its RAG tools apply: the thread or its project has
 * documents, the model takes tools, and attachments are on. Lifted out of
 * ThreadConversation.tsx unchanged.
 */
export function useRagToolAvailability({
  thread,
  toolsEnabled,
  updateRagToolsAvailability,
}: {
  thread: Thread | undefined
  toolsEnabled: boolean
  updateRagToolsAvailability: ReturnType<typeof useChat>['updateRagToolsAvailability']
}) {
  // Global disabled-tools set; re-run the effect below when it changes.
  const disabledTools = useToolAvailable((state) => state.disabledTools)

  // Update RAG tools availability when documents, model, or tool availability changes
  useEffect(() => {
    const checkDocumentsAvailability = async () => {
      const hasThreadDocuments = Boolean(thread?.metadata?.hasDocuments)
      let hasProjectDocuments = false

      // Check if thread belongs to a project and if that project has files
      const projectId = thread?.metadata?.project?.id
      if (projectId) {
        try {
          const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
            ExtensionTypeEnum.VectorDB
          )
          if (ext?.listAttachmentsForProject) {
            const projectFiles = await ext.listAttachmentsForProject(projectId)
            hasProjectDocuments = projectFiles.length > 0
            void warnIfProjectFilesChanged(projectId, projectFiles)
          }
        } catch (error) {
          console.warn('Failed to check project files:', error)
        }
      }

      const hasDocuments = hasThreadDocuments || hasProjectDocuments
      const ragFeatureAvailable = Boolean(useAttachments.getState().enabled)
      const modelSupportsTools = toolsEnabled

      updateRagToolsAvailability(
        hasDocuments,
        modelSupportsTools,
        ragFeatureAvailable
      )
    }

    checkDocumentsAvailability()
  }, [
    thread?.metadata?.hasDocuments,
    thread?.metadata?.project?.id,
    toolsEnabled,
    updateRagToolsAvailability,
    disabledTools, // Re-run when tools are enabled/disabled
  ])
}
