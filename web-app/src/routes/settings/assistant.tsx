import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useState } from 'react'

import { useAssistant } from '@/hooks/useAssistant'

import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Icon } from '@/components/ui/icon'
import AddEditAssistant from '@/containers/dialogs/AddEditAssistant'
import { toast } from 'sonner'
import { DeleteAssistantDialog } from '@/containers/dialogs'
import { archiveAssistant } from '@/lib/archiveAssistants'
import { errorText } from '@/lib/errorText'
import { AvatarEmoji } from '@/containers/AvatarEmoji'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Card, CardItem } from '@/containers/Card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DropdownMenuSeparator } from '@radix-ui/react-dropdown-menu'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.assistant as any)({
  component: AssistantContent,
})

function AssistantContent() {
  const { t } = useTranslation()
  const {
    assistants,
    addAssistant,
    updateAssistant,
    deleteAssistant,
    defaultAssistantId,
    setDefaultAssistant,
  } = useAssistant()
  const [open, setOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleDelete = (id: string) => {
    setDeletingId(id)
    setDeleteConfirmOpen(true)
  }

  const confirmDelete = async () => {
    if (deletingId) {
      const target = assistants.find((a) => a.id === deletingId)
      try {
        if (target) await archiveAssistant(target)
      } catch (e) {
        toast.error(t('archive:deleteFailed'), { description: errorText(e) })
        return
      }
      deleteAssistant(deletingId)
      setDeleteConfirmOpen(false)
      setDeletingId(null)
    }
  }

  const handleSave = (assistant: Assistant) => {
    if (editingKey) {
      updateAssistant(assistant)
    } else {
      addAssistant(assistant)
    }
    setOpen(false)
    setEditingKey(null)
  }

  const sortedAssistants = assistants
    .slice()
    .sort((a, b) => a.created_at - b.created_at)
  const defaultAssistant = sortedAssistants.find(
    (a) => a.id === defaultAssistantId
  )

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader title={t('common:assistants')} />
      <SettingsPageBody
        title={t('common:assistants')}
        description={t('settings:pageDesc.assistants')}
        actions={
          <Button
            onClick={() => {
              setEditingKey(null)
              setOpen(true)
            }}
            className="pointer-coarse:h-11"
          >
            <Icon name="x-plus-w" size={14} />
            {t('assistants:addAssistant')}
          </Button>
        }
      >
        <Card
          title={t('assistants:allAssistants')}
          aside={<span className="tabular-nums">{sortedAssistants.length}</span>}
        >
          {/* Default Assistant */}
          <CardItem
            anchor="settings-assistants-default"
            title={t('assistants:defaultAssistantSection')}
            description={t('assistants:defaultAssistantDesc')}
            actions={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="max-w-full justify-between pointer-coarse:h-11"
                  >
                    <span className={cn('truncate')}>
                      {defaultAssistant?.name ?? t('assistants:lastUsed')}
                    </span>
                    <Icon name="arrow-down" size={12} className="ml-2 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40 max-h-80">
                  <DropdownMenuItem
                    key="none"
                    className={cn(
                      'cursor-pointer my-0.5',
                      !defaultAssistantId && 'bg-accent'
                    )}
                    onClick={() => setDefaultAssistant('')}
                  >
                    {t('assistants:lastUsed')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {sortedAssistants.map((a) => (
                    <DropdownMenuItem
                      key={a.id}
                      className={cn(
                        'cursor-pointer my-0.5',
                        defaultAssistantId === a.id && 'bg-accent'
                      )}
                      onClick={() => setDefaultAssistant(a.id)}
                    >
                      {a.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
          <ul className="grid gap-3 pt-3 @min-[40rem]:grid-cols-2 @min-[72rem]:grid-cols-3">
            {sortedAssistants.map((assistant) => (
              <li
                className="group flex min-w-0 items-start gap-3 rounded-xl border-[0.8px] border-border bg-card p-3 transition-colors hover:border-border-strong"
                key={assistant.id}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border-[0.8px] border-input bg-card">
                  {assistant?.avatar && (
                    <AvatarEmoji
                      avatar={assistant?.avatar}
                      imageClassName="size-5 object-contain"
                      textClassName="text-xl"
                    />
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] leading-[1.2] font-medium text-foreground">
                      {assistant.name}
                    </span>
                    {defaultAssistantId === assistant.id && (
                      <span className="inline-flex h-[18px] shrink-0 items-center rounded-md border-[0.8px] border-border bg-card px-2 text-xs font-medium leading-none text-fg-2">
                        {t('assistants:isDefault')}
                      </span>
                    )}
                  </div>
                  {assistant.description && (
                    <p className="line-clamp-3 text-xs leading-[1.35] text-muted-foreground">
                      {assistant.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center shrink-0">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="pointer-coarse:size-11"
                    aria-label={`${t('assistants:editAssistant')}: ${assistant.name}`}
                    title={t('assistants:editAssistant')}
                    onClick={() => {
                      setEditingKey(assistant.id)
                      setOpen(true)
                    }}
                  >
                    <Icon name="x-edit" size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="hover:text-destructive pointer-coarse:size-11"
                    aria-label={`${t('assistants:deleteAssistant')}: ${assistant.name}`}
                    title={t('assistants:deleteAssistant')}
                    onClick={() => handleDelete(assistant.id)}
                  >
                    <Icon name="x-trash" size={16} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </SettingsPageBody>
      <AddEditAssistant
        open={open}
        onOpenChange={setOpen}
        editingKey={editingKey}
        initialData={
          editingKey ? assistants.find((a) => a.id === editingKey) : undefined
        }
        onSave={handleSave}
      />
      <DeleteAssistantDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        onConfirm={confirmDelete}
        assistantName={assistants.find((a) => a.id === deletingId)?.name}
      />
    </div>
  )
}
