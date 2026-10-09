import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useAssistant } from '@/hooks/useAssistant'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ProjectModel } from '@/services/projects/types'
import { AvatarEmoji } from '@/containers/AvatarEmoji'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ChevronDown, Plus } from 'lucide-react'
import AddEditAssistant from './AddEditAssistant'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { looksLikeFilesystemPath } from '@/lib/collectionName'
import { useCoworkRun } from '@/hooks/useCoworkRun'

interface AddProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingKey: string | null
  initialData?: {
    id: string
    name: string
    updated_at: number
    assistantId?: string
    model?: ProjectModel
  }
  onSave: (name: string, assistantId?: string, model?: ProjectModel) => void
  /**
   * What the thing being created is called. The chat row's "New group…"
   * creates a sidebar group, so it says "group"; other callers keep the
   * collection wording.
   */
  noun?: 'collection' | 'group'
}

export default function AddProjectDialog({
  open,
  onOpenChange,
  editingKey,
  initialData,
  onSave,
  noun = 'collection',
}: AddProjectDialogProps) {
  const { t } = useTranslation()
  const dialogKey =
    noun === 'group' ? 'projects.addGroupDialog' : 'projects.addProjectDialog'
  const navigate = useNavigate()
  const [name, setName] = useState(initialData?.name || '')
  const [selectedAssistantId, setSelectedAssistantId] = useState<string | undefined>(initialData?.assistantId)
  const [selectedModel, setSelectedModel] = useState<ProjectModel | undefined>(
    initialData?.model
  )
  const providers = useModelProvider((s) => s.providers)
  const modelChoices = providers
    .filter((p) => p.active && p.models.length > 0)
    .map((p) => ({
      provider: p.provider,
      label: p.displayName ?? p.provider,
      models: p.models.filter((m) => !m.embedding),
    }))
    .filter((p) => p.models.length > 0)
  const { folders } = useThreadManagement()
  const { assistants, addAssistant } = useAssistant()
  const [addAssistantDialogOpen, setAddAssistantDialogOpen] = useState(false)

  const selectedAssistant = assistants.find((a) => a.id === selectedAssistantId)

  useEffect(() => {
    if (open) {
      setName(initialData?.name || '')
      setSelectedAssistantId(initialData?.assistantId)
      setSelectedModel(initialData?.model)
    }
  }, [open, initialData])

  const handleSave = () => {
    if (!name.trim()) return

    const trimmedName = name.trim()

    // Check for duplicate names (excluding current project when editing)
    const isDuplicate = folders.some(
      (folder) =>
        folder.name.toLowerCase() === trimmedName.toLowerCase() &&
        folder.id !== editingKey
    )

    if (isDuplicate) {
      toast.warning(t(`${dialogKey}.alreadyExists`, { projectName: trimmedName }))
      return
    }

    onSave(trimmedName, selectedAssistantId, selectedModel)

    // Show success message
    if (editingKey) {
      toast.success(t(`${dialogKey}.updateSuccess`, { projectName: trimmedName }))
    } else {
      toast.success(t(`${dialogKey}.createSuccess`, { projectName: trimmedName }))
    }
    setName('')
    setSelectedAssistantId(undefined)
    setSelectedModel(undefined)
  }

  /**
   * Take the user to the thing they were actually trying to do.
   *
   * The name they typed is not carried across: a collection name is a label,
   * and treating it as a path is the confusion this notice exists to end. The
   * picker asks for the folder properly.
   */
  const openCodeFolder = () => {
    useCoworkRun.getState().requestAttachFolder()
    onOpenChange(false)
    void navigate({ to: route.cowork })
  }

  const handleCancel = () => {
    onOpenChange(false)
    setName('')
    setSelectedAssistantId(undefined)
    setSelectedModel(undefined)
  }

  // Check if the button should be disabled
  const hasChanged = editingKey
    ? name.trim() !== initialData?.name || selectedAssistantId !== initialData?.assistantId ||
      selectedModel?.id !== initialData?.model?.id ||
      selectedModel?.provider !== initialData?.model?.provider
    : true
  const isButtonDisabled = !name.trim() || (editingKey && !hasChanged)

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingKey ? t(`${dialogKey}.editTitle`) : t(`${dialogKey}.createTitle`)}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t(`${dialogKey}.namePlaceholder`)}
              className="mt-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isButtonDisabled) {
                  handleSave()
                }
              }}
            />
            {/* Said where the misunderstanding happens, next to the field that
                causes it, rather than after a collection has been made. */}
            {looksLikeFilesystemPath(name) && (
              <div
                role="status"
                className="mt-2 rounded-md border border-border bg-muted p-2"
              >
                <p className="text-xs text-fg-2">
                  {t('projects.pathNameNotice')}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-7 text-xs"
                  onClick={openCodeFolder}
                >
                  {t('projects.openCodeFolderInCowork')}
                </Button>
              </div>
            )}
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              {t('projects.addProjectDialog.assistant')}
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full justify-between rounded-md"
                >
                  {selectedAssistant ? (
                    <div className="flex items-center gap-2">
                      {selectedAssistant.avatar && (
                        <AvatarEmoji
                          avatar={selectedAssistant.avatar}
                          imageClassName="w-4 h-4 object-contain"
                          textClassName="text-sm"
                        />
                      )}
                      <span>{selectedAssistant.name}</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('projects.addProjectDialog.selectAssistant')}
                    </span>
                  )}
                  <ChevronDown className="size-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
                <DropdownMenuItem
                  onSelect={() => setSelectedAssistantId(undefined)}
                >
                  <span className="text-muted-foreground">
                    {t('projects.addProjectDialog.noAssistant')}
                  </span>
                </DropdownMenuItem>
                {assistants.map((assistant) => (
                  <DropdownMenuItem
                    key={assistant.id}
                    onSelect={() => setSelectedAssistantId(assistant.id)}
                  >
                    <div className="flex items-center gap-2">
                      {assistant.avatar && (
                        <AvatarEmoji
                          avatar={assistant.avatar}
                          imageClassName="w-4 h-4 object-contain"
                          textClassName="text-sm"
                        />
                      )}
                      <span>{assistant.name}</span>
                    </div>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setAddAssistantDialogOpen(true)}
                >
                  <div className="flex items-center gap-2">
                    <Plus className="size-4" />
                    <span>{t('projects.addProjectDialog.addAssistant')}</span>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              {t('projects.addProjectDialog.model')}
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full justify-between rounded-md"
                >
                  {selectedModel ? (
                    <span className="truncate">{selectedModel.id}</span>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('projects.addProjectDialog.selectModel')}
                    </span>
                  )}
                  <ChevronDown className="size-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="max-h-72 w-(--radix-dropdown-menu-trigger-width) overflow-y-auto"
                align="start"
              >
                <DropdownMenuItem onClick={() => setSelectedModel(undefined)}>
                  <span className="text-muted-foreground">
                    {t('projects.addProjectDialog.noModel')}
                  </span>
                </DropdownMenuItem>
                {modelChoices.map((group) => (
                  <div key={group.provider}>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                    {group.models.map((m) => (
                      <DropdownMenuItem
                        key={`${group.provider}/${m.id}`}
                        onClick={() =>
                          setSelectedModel({ id: m.id, provider: group.provider })
                        }
                      >
                        <span className="truncate">{m.displayName ?? m.name ?? m.id}</span>
                      </DropdownMenuItem>
                    ))}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={handleCancel}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={Boolean(isButtonDisabled)}>
            {editingKey ? t('projects.addProjectDialog.updateButton') : t('projects.addProjectDialog.createButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AddEditAssistant
      open={addAssistantDialogOpen}
      onOpenChange={setAddAssistantDialogOpen}
      editingKey={null}
      onSave={(assistant) => {
        addAssistant(assistant)
        setSelectedAssistantId(assistant.id)
      }}
    />
  </>
  )
}
