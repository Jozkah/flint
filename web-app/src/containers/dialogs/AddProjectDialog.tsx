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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useAssistant } from '@/hooks/useAssistant'
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
  }
  onSave: (name: string, assistantId?: string) => void
}

export default function AddProjectDialog({
  open,
  onOpenChange,
  editingKey,
  initialData,
  onSave,
}: AddProjectDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [name, setName] = useState(initialData?.name || '')
  const [selectedAssistantId, setSelectedAssistantId] = useState<string | undefined>(initialData?.assistantId)
  const { folders } = useThreadManagement()
  const { assistants, addAssistant } = useAssistant()
  const [addAssistantDialogOpen, setAddAssistantDialogOpen] = useState(false)

  const selectedAssistant = assistants.find((a) => a.id === selectedAssistantId)

  useEffect(() => {
    if (open) {
      setName(initialData?.name || '')
      setSelectedAssistantId(initialData?.assistantId)
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
      toast.warning(t('projects.addProjectDialog.alreadyExists', { projectName: trimmedName }))
      return
    }

    onSave(trimmedName, selectedAssistantId)

    // Show success message
    if (editingKey) {
      toast.success(t('projects.addProjectDialog.updateSuccess', { projectName: trimmedName }))
    } else {
      toast.success(t('projects.addProjectDialog.createSuccess', { projectName: trimmedName }))
    }
    setName('')
    setSelectedAssistantId(undefined)
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
  }

  // Check if the button should be disabled
  const hasChanged = editingKey
    ? name.trim() !== initialData?.name || selectedAssistantId !== initialData?.assistantId
    : true
  const isButtonDisabled = !name.trim() || (editingKey && !hasChanged)

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingKey ? t('projects.addProjectDialog.editTitle') : t('projects.addProjectDialog.createTitle')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('projects.addProjectDialog.namePlaceholder')}
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
