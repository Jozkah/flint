import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useState } from 'react'

import { useAssistant } from '@/hooks/useAssistant'

import { SettingsPageHeader } from '@/containers/SettingsPageHeader'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import AddEditAssistant from '@/containers/dialogs/AddEditAssistant'
import { DeleteAssistantDialog } from '@/containers/dialogs'
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
import { ChevronsUpDown } from 'lucide-react'
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
    setDefaultAssistant
  } = useAssistant()
  const [open, setOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleDelete = (id: string) => {
    setDeletingId(id)
    setDeleteConfirmOpen(true)
  }

  const confirmDelete = () => {
    if (deletingId) {
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

  const sortedAssistants = assistants.slice().sort((a, b) => a.created_at - b.created_at)
  const defaultAssistant = sortedAssistants.find((a) => a.id === defaultAssistantId)

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader>
        <Button
          onClick={() => {
            setEditingKey(null)
            setOpen(true)
          }}
          size="sm"
          className="pointer-coarse:h-11"
        >
          <Plus aria-hidden />
          {t('assistants:addAssistant')}
        </Button>
      </SettingsPageHeader>
      <div className="flex h-[calc(100%-var(--ctx-h))] min-h-0">
        <div className="flex size-full min-w-0">
          <div className="flex w-full min-w-0 flex-col gap-4 overflow-x-hidden overflow-y-auto px-3 py-4 md:px-6 md:py-6 [&>*]:mx-auto [&>*]:max-w-4xl">
            {/* Default Assistant */}
            <Card>
              <CardItem
                anchor="settings-assistants-default"
                title={t('assistants:defaultAssistantSection')}
                description={t('assistants:defaultAssistantDesc')}
                actions={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="max-w-full justify-between pointer-coarse:h-11">
                        <span className={cn('truncate')}>
                          {defaultAssistant?.name ?? t('assistants:lastUsed')}
                        </span>
                        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40 max-h-80">
                      <DropdownMenuItem
                        key="none"
                        className={cn(
                          'cursor-pointer my-0.5',
                          !defaultAssistantId && 'bg-brand-tint'
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
                            defaultAssistantId === a.id && 'bg-brand-tint'
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
              <h1 className="mt-5 mb-3 text-lg font-semibold text-foreground">{t('assistants:allAssistants')}</h1>
              {sortedAssistants.map((assistant) => (
                <div
                  className="group my-1.5 flex min-h-11 items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 transition-colors hover:bg-sunken"
                  key={assistant.id}
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sunken">
                    {assistant?.avatar && (
                      <AvatarEmoji
                        avatar={assistant?.avatar}
                        imageClassName="size-6 object-contain"
                        textClassName="text-2xl"
                      />
                    )}
                  </div>
                  <div className="flex flex-col min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {assistant.name}
                      </span>
                      {defaultAssistantId === assistant.id && (
                        <span className="shrink-0 rounded-full bg-brand-tint px-1.5 py-0.5 text-[10px] font-medium leading-none text-brand-text">
                          {t('assistants:isDefault')}
                        </span>
                      )}
                    </div>
                    {assistant.description && (
                      <p className="mt-0.5 line-clamp-1 pr-2 text-xs text-muted-foreground">
                        {assistant.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center shrink-0">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="pointer-coarse:size-11"
                      aria-label={`${t('assistants:editAssistant')}: ${assistant.name}`}
                      title={t('assistants:editAssistant')}
                      onClick={() => {
                        setEditingKey(assistant.id)
                        setOpen(true)
                      }}
                    >
                      <Pencil className="text-muted-foreground" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="pointer-coarse:size-11"
                      aria-label={`${t('assistants:deleteAssistant')}: ${assistant.name}`}
                      title={t('assistants:deleteAssistant')}
                      onClick={() => handleDelete(assistant.id)}
                    >
                      <Trash2 className="text-destructive" aria-hidden />
                    </Button>
                  </div>
                </div>
              ))}
            </Card>
          </div>
          <AddEditAssistant
            open={open}
            onOpenChange={setOpen}
            editingKey={editingKey}
            initialData={
              editingKey
                ? assistants.find((a) => a.id === editingKey)
                : undefined
            }
            onSave={handleSave}
          />
          <DeleteAssistantDialog
            open={deleteConfirmOpen}
            onOpenChange={setDeleteConfirmOpen}
            onConfirm={confirmDelete}
          />
        </div>
      </div>
    </div>
  )
}
