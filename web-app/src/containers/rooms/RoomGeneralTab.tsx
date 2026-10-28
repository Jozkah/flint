/* eslint-disable react-refresh/only-export-components */
import { Plus } from 'lucide-react'
import type { Room } from '@/lib/rooms/types'
import { MAX_EXTRA_FOLDERS } from '@/lib/rooms/controller'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'

export function RoomGeneralTab({
  hidden, uid, room, title, objective, onTitle, onObjective, attachFolder, detachFolder, addExtraFolder, removeExtraFolder,
}: {
  hidden: boolean
  uid: string
  room: Room
  title: string
  objective: string
  onTitle: (v: string) => void
  onObjective: (v: string) => void
  attachFolder: () => Promise<void>
  detachFolder: () => Promise<void>
  addExtraFolder: () => Promise<void>
  removeExtraFolder: (path: string) => Promise<void>
}) {
  const { t } = useTranslation()
  return (
      <div hidden={hidden} className="flex min-w-0 flex-col gap-2.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-title`}>{t('rooms:editor.title')}</Label>
          <Input id={`${uid}-title`} value={title} onChange={(e) => onTitle(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-objective`}>{t('rooms:editor.objective')}</Label>
          <Textarea
            id={`${uid}-objective`}
            rows={2}
            value={objective}
            onChange={(e) => onObjective(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('rooms:editor.workingFolder')}</Label>
          {room.folder ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-[length:calc(var(--ui-font-base)*0.71875)]">
                {room.folder}
              </code>
              <Button type="button" size="xs" variant="outline" onClick={() => void attachFolder()}>
                {t('rooms:editor.changeFolder')}
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => void detachFolder()}>
                {t('rooms:editor.detachFolder')}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => void attachFolder()}
            >
              {t('rooms:editor.attachFolder')}
            </Button>
          )}
          {(room.extraFolders ?? []).map((f) => (
            <div key={f} className="flex flex-wrap items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-[length:calc(var(--ui-font-base)*0.71875)]">
                {f}
              </code>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => void removeExtraFolder(f)}
              >
                {t('rooms:editor.detachFolder')}
              </Button>
            </div>
          ))}
          {room.folder && (room.extraFolders ?? []).length < MAX_EXTRA_FOLDERS && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="self-start"
              onClick={() => void addExtraFolder()}
            >
              <Plus className="size-3.5" aria-hidden />
              {t('rooms:editor.addFolder')}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">{t('rooms:editor.workingFolderHint')}</p>
        </div>
      </div>
  )
}
