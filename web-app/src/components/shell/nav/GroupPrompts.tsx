import { useState } from 'react'
import { FolderIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { basename } from '@/lib/groups/domain'
import { missingFolders, type JoinChoice } from '@/lib/groups/inherit'
import { useKeepFoldersPrompt } from '@/lib/groups/keepPrompt'
import type { GroupSurface } from '@/lib/groups/types'

type Option = Exclude<JoinChoice, 'cancel'>

const OPTIONS: { value: Option; title: string; body: string }[] = [
  { value: 'keep', title: 'keepCurrent', body: 'keepCurrentBody' },
  { value: 'inherit', title: 'inheritGroup', body: 'inheritGroupBody' },
  { value: 'merge', title: 'mergeFolders', body: 'mergeFoldersBody' },
  { value: 'addToGroup', title: 'addToGroup', body: 'addToGroupBody' },
]

function FolderList({ title, paths }: { title: string; paths: string[] }) {
  const { t } = useTranslation()
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      {paths.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('common:groups.none')}</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {paths.map((p) => (
            <li key={p} className="flex items-center gap-1 truncate text-xs" title={p}>
              <FolderIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{basename(p)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The folder questions a group move asks, for one surface: how an item's
 * folders and a group's combine when it joins (keep, use the group's, merge,
 * or add the item's to the group), and whether an item leaving a group keeps
 * the folders it got from it.
 */
export function GroupPrompts({ surface }: { surface: GroupSurface }) {
  const { t } = useTranslation()
  const keepAsk = useKeepFoldersPrompt((s) =>
    s.request?.surface === surface ? s.request : null
  )
  const answerKeep = useKeepFoldersPrompt((s) => s.answer)
  const join = useKeepFoldersPrompt((s) =>
    s.join?.surface === surface ? s.join : null
  )
  const answerJoin = useKeepFoldersPrompt((s) => s.answerJoin)
  const [choice, setChoice] = useState<Option>('merge')

  const groupPaths = join?.group.folderBindings.map((b) => b.path) ?? []
  const nothingToAdd = join ? missingFolders(groupPaths, join.own).length === 0 : true
  const close = (c: JoinChoice) => {
    answerJoin(c)
    setChoice('merge')
  }

  return (
    <>
      <Dialog open={join !== null} onOpenChange={(o) => !o && close('cancel')}>
        <DialogContent className="sm:max-w-lg" data-testid="group-join-dialog">
          <DialogHeader>
            <DialogTitle>
              {t('common:groups.joinTitle', { name: join?.group.name })}
            </DialogTitle>
            <DialogDescription>{t('common:groups.joinBody')}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-4 rounded-md bg-secondary p-2">
            <FolderList title={t('common:groups.itemFolders')} paths={join?.own ?? []} />
            <FolderList title={t('common:groups.groupFolders')} paths={groupPaths} />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            {OPTIONS.map((o) => {
              const disabled = o.value === 'addToGroup' && nothingToAdd
              return (
                <label
                  key={o.value}
                  className={cn(
                    'flex cursor-pointer gap-2 rounded-md border border-border p-2 text-sm has-[:checked]:border-foreground/40',
                    disabled && 'cursor-not-allowed opacity-50'
                  )}
                >
                  <input
                    type="radio"
                    name={`folder-choice-${surface}`}
                    value={o.value}
                    checked={choice === o.value}
                    disabled={disabled}
                    onChange={() => setChoice(o.value)}
                    className="mt-1"
                    data-testid={`folder-choice-${o.value}`}
                  />
                  <span>
                    <span className="font-medium">{t(`common:groups.${o.title}`)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`common:groups.${o.body}`)}
                    </span>
                  </span>
                </label>
              )
            })}
          </fieldset>
          <DialogFooter>
            <Button variant="ghost" onClick={() => close('cancel')}>
              {t('common:cancel')}
            </Button>
            <Button onClick={() => close(choice)} data-testid="group-join-confirm">
              {t('common:groups.move')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={keepAsk !== null} onOpenChange={(o) => !o && answerKeep(true)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('common:groups.keepTitle')}</DialogTitle>
            <DialogDescription>
              {t('common:groups.keepBody', { name: keepAsk?.groupName })}
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
            {keepAsk?.paths.map((p) => (
              <li key={p} className="truncate" title={p}>
                {p}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => answerKeep(false)}
              data-testid="group-detach-folders"
            >
              {t('common:groups.detach')}
            </Button>
            <Button onClick={() => answerKeep(true)} data-testid="group-keep-folders">
              {t('common:groups.keep')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
