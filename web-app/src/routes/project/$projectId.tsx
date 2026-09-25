import { createFileRoute, useParams } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useThreads } from '@/hooks/useThreads'
import { useAssistant } from '@/hooks/useAssistant'
import { useTranslation } from '@/i18n/react-i18next-compat'

import ChatInput from '@/containers/ChatInput'
import HeaderPage from '@/containers/HeaderPage'
import ThreadList from '@/containers/ThreadList'
import { AvatarEmoji } from '@/containers/AvatarEmoji'

import { FolderPenIcon, MessageCircle, MoreHorizontal, PencilIcon, Trash2 } from 'lucide-react'
import ProjectFiles from '@/containers/ProjectFiles'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import { DeleteProjectDialog } from '@/containers/dialogs/DeleteProjectDialog'
import { DeleteAllThreadsInProjectDialog } from '@/containers/dialogs/DeleteAllThreadsInProjectDialog'
import { NavList } from '@/components/shell/nav-kit'

export const Route = createFileRoute('/project/$projectId')({
  component: ProjectPageContent,
})

function ProjectPageContent() {
  const { t, i18n } = useTranslation()
  const { projectId } = useParams({ from: '/project/$projectId' })
  const { getFolderById, updateFolder } = useThreadManagement()
  const threads = useThreads((state) => state.threads)
  const deleteAllThreadsByProject = useThreads((state) => state.deleteAllThreadsByProject)
  const { assistants } = useAssistant()

  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // Find the project
  const project = getFolderById(projectId)

  // Find the assigned assistant
  const projectAssistant = useMemo(() => {
    if (!project?.assistantId) return null
    return assistants.find((a) => a.id === project.assistantId) || null
  }, [project?.assistantId, assistants])

  // Get threads for this project
  const projectThreads = useMemo(() => {
    return Object.values(threads)
      .filter((thread) => thread.metadata?.project?.id === projectId)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0))
  }, [threads, projectId])

  const handleSaveEdit = async (name: string, assistantId?: string) => {
    if (project) {
      await updateFolder(project.id, name, assistantId)
      setEditDialogOpen(false)
    }
  }

  const handleDeleteAllThreads = () => {
    deleteAllThreadsByProject(projectId)
  }

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4">
        <div className="text-center">
          <h1 className="font-semibold  text-xl leading-tight mb-2">
            {t('projects.projectNotFound')}
          </h1>
          <p className="text-muted-foreground">
            {t('projects.projectNotFoundDesc')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full w-full bg-background">
      <HeaderPage>
        {/* The collection's name is the page title; its actions sit beside
            it, the model on the right. */}
        <div className="flex min-w-0 items-center gap-1.5 w-full md:pr-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <h1
              className="min-w-0 truncate text-sm font-semibold text-foreground"
              title={project.name}
            >
              {project.name}
            </h1>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="shrink-0 text-ink-2 hover:text-foreground pointer-coarse:size-11">
                  <MoreHorizontal className="size-4" />
                  <span className="sr-only">More options</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditDialogOpen(true)}>
                  <FolderPenIcon className="size-4" />
                  <span>{t('projects.editProject')}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDeleteDialogOpen(true)}
                >
                  <Trash2 className="size-4" />
                  <span>{t('projects.deleteProject')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="min-w-0 shrink">
            <DropdownModelProvider />
          </div>
        </div>
      </HeaderPage>

      <div className="min-h-0 flex-1 min-w-0 relative flex flex-col px-3 md:px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-[calc(var(--read-w)+3rem)]">
          {/* Chat Input */}
          <div className="mb-5">
            <ChatInput
              showSpeedToken={false}
              initialMessage={true}
              projectId={projectId}
              projectAssistantId={project.assistantId}
            />
          </div>

          {/* Conversation Section */}
          {projectThreads.length > 0 && (
            <div className="flex flex-col mb-5">
              <div className="flex items-center justify-between gap-2 mb-1 px-1">
                <h2 className="text-[13px] font-semibold text-foreground">
                  {t('projects.conversation')}
                </h2>
                <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="pointer-coarse:size-11">
                      <MoreHorizontal className="size-4" />
                      <span className="sr-only">More options</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start">
                    <DeleteAllThreadsInProjectDialog
                      projectName={project.name}
                      threadCount={projectThreads.length}
                      onDeleteAll={handleDeleteAllThreads}
                      onDropdownClose={() => setDropdownOpen(false)}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <NavList>
                <ThreadList
                  threads={projectThreads}
                  currentProjectId={projectId}
                />
              </NavList>
            </div>
          )}

          {/* Empty State */}
          {projectThreads.length === 0 && (
            <div className="flex flex-col items-center justify-center px-4 py-6 text-center mb-5">
              <MessageCircle className="size-5 text-muted-foreground mb-2" />
              <h3 className="text-sm font-semibold text-foreground mb-0.5">
                {t('projects.noConversationsIn', { projectName: project.name })}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('projects.startNewConversation', { projectName: project.name })}
              </p>
            </div>
          )}

          {/* Project Settings Card */}
          <div className="rounded-lg border border-border overflow-hidden mb-6 bg-card">
            {/* Assistant Section */}
            <div className="flex items-center justify-between gap-3 p-4 border-b border-border">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">{t('projects.addProjectDialog.assistant')}</h3>
                {projectAssistant ? (
                  <div className="flex items-center gap-1.5 mt-1">
                    {projectAssistant.avatar && (
                      <AvatarEmoji
                        avatar={projectAssistant.avatar}
                        imageClassName="w-4 h-4 object-contain"
                        textClassName="text-sm"
                      />
                    )}
                    <span className="text-sm text-muted-foreground">{projectAssistant.name}</span>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('projects.noAssistantAssigned')}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditDialogOpen(true)}
              >
                <PencilIcon className="size-3" />
                <span>{t('common:edit')}</span>
              </Button>
            </div>

            {/* Files Section */}
            <ProjectFiles projectId={projectId} lng={i18n.language} />
          </div>
        </div>
      </div>

      <AddProjectDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        editingKey={project.id}
        initialData={project}
        onSave={handleSaveEdit}
      />

      <DeleteProjectDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        projectId={project.id}
        projectName={project.name}
      />
    </div>
  )
}
