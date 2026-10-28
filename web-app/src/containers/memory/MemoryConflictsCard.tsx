import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type {
  MemoryConflictPair,
  MemoryView,
} from '@janhq/tauri-plugin-agent-tools-api'
import { scopeLabel } from './memoryScopes'

type Props = {
  conflicts: MemoryConflictPair[]
  busy: boolean
  onKeep: (keep: MemoryView, drop: MemoryView) => void | Promise<void>
}

export function MemoryConflictsCard({ conflicts, busy, onKeep }: Props) {
  const { t } = useTranslation()
  return (
    <Card title={t('settings:memoryPage.conflictsTitle')}>
      <p className="mb-1.5 text-[length:calc(var(--ui-font-base)*0.78125)] leading-normal text-muted-foreground">
        {t('settings:memoryPage.conflictsBody')}
      </p>
      <ul className="flex flex-col gap-3" data-testid="memory-conflicts">
        {conflicts.map((conflict) => (
          <li
            key={`${conflict.left.id}|${conflict.right.id}`}
            data-testid="memory-conflict"
            data-left-id={conflict.left.id}
            data-right-id={conflict.right.id}
          >
            <p className="mb-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-[.025em] text-subtle-foreground uppercase">
              {t('settings:memoryPage.conflictAbout', { subject: conflict.subject })}
            </p>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {(
                [
                  [conflict.left, conflict.right],
                  [conflict.right, conflict.left],
                ] satisfies Array<[MemoryView, MemoryView]>
              ).map(([side, other]: [MemoryView, MemoryView]) => (
                <div key={side.id} className="flex min-w-0 flex-col gap-2 rounded-[10px] border-[0.8px] border-border bg-background p-2.5">
                  <p className="text-[length:calc(var(--ui-font-base)*0.8125)] break-words text-foreground">{side.content}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {scopeLabel(side.scope, t)}
                    {' · '}
                    <span className="break-all">{side.id}</span>
                  </p>
                  <Button
                    variant="outline"
                    className="mt-0.5 self-start pointer-coarse:h-11"
                    disabled={busy}
                    data-testid="memory-conflict-keep"
                    data-keep-id={side.id}
                    aria-label={t('settings:memoryPage.keepAria', { preview: side.preview })}
                    onClick={() => void onKeep(side, other)}
                  >
                    {t('settings:memoryPage.keepThis')}
                  </Button>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
