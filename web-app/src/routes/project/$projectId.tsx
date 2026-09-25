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

import {
  FolderPenIcon,
  MessageCircle,
  MoreHorizontal,
  PencilIcon,
  Settings2,
  Trash2,
} from 'lucide-react'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
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
    <div className="flex h-full w-full flex-col">
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
                <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:size-11">
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

      {/* The mockup's collection page: the composer and the conversations on
          the left, the collection's settings in a Frame on the right. */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-1 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] [scrollbar-width:thin]">
        <div className="grid w-full grid-cols-1 gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-4">
            <ChatInput
              showSpeedToken={false}
              initialMessage={true}
              projectId={projectId}
              projectAssistantId={project.assistantId}
            />

            <Frame className="motion-safe:animate-rise-in motion-safe:[animation-delay:100ms]">
              <FrameHeader
                icon={<MessageCircle />}
                title={t('projects.conversation')}
                actions={
                  projectThreads.length > 0 && (
                    <DropdownMenu
                      open={dropdownOpen}
                      onOpenChange={setDropdownOpen}
                    >
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="pointer-coarse:size-11"
                        >
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
                  )
                }
              />
              <FrameBody className="p-1.5">
                {projectThreads.length > 0 ? (
                  <NavList>
                    <ThreadList
                      threads={projectThreads}
                      currentProjectId={projectId}
                    />
                  </NavList>
                ) : (
                  <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
                    <MessageCircle className="mb-2 size-5 text-muted-foreground" />
                    <h3 className="mb-0.5 text-sm font-medium text-foreground">
                      {t('projects.noConversationsIn', {
                        projectName: project.name,
                      })}
                    </h3>
                    <p className="text-[13px] text-muted-foreground">
                      {t('projects.startNewConversation', {
                        projectName: project.name,
                      })}
                    </p>
                  </div>
                )}
              </FrameBody>
            </Frame>
          </div>

          {/* Project Settings */}
          <Frame className="self-start motion-safe:animate-rise-in motion-safe:[animation-delay:160ms]">
            <FrameHeader icon={<Settings2 />} title={t('common:settings')} />
            <FrameBody className="overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-dashed border-border px-3 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-[13px] font-medium text-foreground">
                    {t('projects.addProjectDialog.assistant')}
                  </h3>
                  {projectAssistant ? (
                    <div className="flex items-center gap-1.5">
                      {projectAssistant.avatar && (
                        <AvatarEmoji
                          avatar={projectAssistant.avatar}
                          imageClassName="w-4 h-4 object-contain"
                          textClassName="text-sm"
                        />
                      )}
                      <span className="truncate text-xs text-muted-foreground">
                        {projectAssistant.name}
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
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
            </FrameBody>
          </Frame>
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
