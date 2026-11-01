import { Pin, PinOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { MemoryView } from '@janhq/tauri-plugin-agent-tools-api'
import { formatWhen } from './memoryScopes'

type Props = {
  memory: MemoryView
  busy: boolean
  onTogglePin: (memory: MemoryView) => void | Promise<void>
  onEdit: (memory: MemoryView) => void
  onForget: (memory: MemoryView) => void | Promise<void>
}

/** One remembered fact: its text, where it came from, and its actions. */
export function MemoryRecordRow({ memory, busy, onTogglePin, onEdit, onForget }: Props) {
  const { t, i18n } = useTranslation()
  return (
    <li
      key={memory.id}
      className="flex items-start justify-between gap-3 px-3 py-3"
      data-testid="memory-row"
      data-memory-id={memory.id}
      data-pinned={memory.pinned ? 'true' : 'false'}
    >
      <div className="min-w-0">
        <p className="text-sm break-words text-foreground">{memory.preview}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {[
            memory.origin === 'explicit'
              ? t('settings:memoryPage.meta.youSaved')
              : t('settings:memoryPage.meta.inferred'),
            memory.pinned ? t('settings:memoryPage.meta.pinned') : null,
            memory.status !== 'active' ? memory.status : null,
            t('settings:memoryPage.meta.used', { count: memory.useCount }),
            t('settings:memoryPage.meta.lastUsed', {
              when: formatWhen(memory.lastUsedAt, t, i18n.language),
            }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <details className="mt-1 text-xs" data-testid="memory-provenance">
          <summary className="cursor-pointer rounded-sm text-acc-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:py-2">
            {t('uiLeftovers:memory.why')}
          </summary>
          <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-0.5 rounded-md bg-muted p-2 text-fg-2 sm:grid-cols-[auto_1fr]">
            <dt>{t('uiLeftovers:memory.id')}</dt>
            <dd className="font-mono break-all">{memory.id}</dd>
            <dt>{t('uiLeftovers:scope')}</dt>
            <dd>{memory.scope}</dd>
            <dt>{t('uiLeftovers:memory.writtenBy')}</dt>
            <dd>
              {memory.creator} ({memory.origin})
            </dd>
            <dt>{t('uiLeftovers:memory.created')}</dt>
            <dd>{formatWhen(memory.createdAt, t, i18n.language)}</dd>
            <dt>{t('uiLeftovers:memory.updated')}</dt>
            <dd>{formatWhen(memory.updatedAt, t, i18n.language)}</dd>
            <dt>{t('uiLeftovers:memory.fromConversation')}</dt>
            <dd className="font-mono break-all">
              {memory.sourceSessionId ?? t('uiLeftovers:memory.notRecorded')}
              {memory.sourceDeleted && ` ${t('uiLeftovers:memory.deletedSince')}`}
            </dd>
            {memory.sourceMessageId && (
              <>
                <dt>{t('uiLeftovers:memory.fromMessage')}</dt>
                <dd className="font-mono break-all">{memory.sourceMessageId}</dd>
              </>
            )}
            {memory.projectId && (
              <>
                <dt>{t('uiLeftovers:memory.projectIdentity')}</dt>
                <dd className="font-mono break-all">{memory.projectId}</dd>
              </>
            )}
            {memory.supersedes && (
              <>
                <dt>{t('uiLeftovers:memory.replaces')}</dt>
                <dd className="font-mono break-all">{memory.supersedes}</dd>
              </>
            )}
            <dt>{t('uiLeftovers:memory.redacted')}</dt>
            <dd>{memory.redacted ? t('uiLeftovers:memory.yes') : t('uiLeftovers:memory.no')}</dd>
            {memory.expiresAt && (
              <>
                <dt>{t('uiLeftovers:memory.expires')}</dt>
                <dd>{formatWhen(memory.expiresAt, t, i18n.language)}</dd>
              </>
            )}
            <dt>{t('uiLeftovers:memory.version')}</dt>
            <dd data-testid="memory-provenance-version">
              {memory.version == null ? t('uiLeftovers:memory.versionUnknown') : memory.version}
            </dd>
            <dt>{t('uiLeftovers:memory.source')}</dt>
            <dd data-testid="memory-provenance-source">{memory.sourceType ?? t('uiLeftovers:memory.unknown')}</dd>
            {memory.importedFrom && (
              <>
                <dt>{t('uiLeftovers:memory.importedFrom')}</dt>
                <dd className="break-all" data-testid="memory-provenance-imported">
                  {t('uiLeftovers:memory.importedExport', {
                    id: memory.importedFrom.export_id,
                    scope: memory.importedFrom.exported_scope,
                    when: formatWhen(memory.importedFrom.exported_at, t, i18n.language),
                  })}
                </dd>
                <dt>{t('uiLeftovers:memory.originally')}</dt>
                <dd className="break-all" data-testid="memory-provenance-original">
                  {memory.importedFrom.original_source_type} ·{' '}
                  <span className="font-mono">{memory.importedFrom.original_id}</span> ·{' '}
                  {t('uiLeftovers:memory.createdWhen', { when: formatWhen(memory.importedFrom.original_created_at, t, i18n.language) })}
                  {memory.importedFrom.original_session_id &&
                    ` · ${t('uiLeftovers:memory.conversationId', { id: memory.importedFrom.original_session_id })}`}
                  {memory.importedFrom.original_run_id &&
                    ` · ${t('uiLeftovers:memory.runId', { id: memory.importedFrom.original_run_id })}`}
                </dd>
              </>
            )}
            <dt>{t('uiLeftovers:memory.fromRun')}</dt>
            <dd className="font-mono break-all">{memory.sourceRunId ?? t('uiLeftovers:memory.notRecorded')}</dd>
            <dt>{t('uiLeftovers:memory.savedInProject')}</dt>
            <dd className="font-mono break-all">{memory.sourceProjectId ?? t('uiLeftovers:memory.notRecorded')}</dd>
            {memory.contentHash && (
              <>
                <dt>{t('uiLeftovers:memory.contentHash')}</dt>
                <dd className="font-mono break-all">{memory.contentHash}</dd>
              </>
            )}
            {(memory.history?.length ?? 0) > 0 && (
              <>
                <dt>{t('uiLeftovers:memory.earlierVersions')}</dt>
                <dd data-testid="memory-provenance-history">
                  {memory.history!.map((h) => (
                    <span key={`${h.version}-${h.content_hash}`} className="block font-mono break-all">
                      v{h.version} · {h.content_hash} · {t('settings:memoryPage.replacedAt', { when: formatWhen(h.replaced_at, t, i18n.language) })}
                    </span>
                  ))}
                </dd>
              </>
            )}
            <dt>{t('uiLeftovers:memory.usedIn')}</dt>
            <dd data-testid="memory-provenance-uses">
              {(memory.uses?.length ?? 0) === 0
                ? t('uiLeftovers:memory.noRequests')
                : memory.uses!.map((u, i: number) => (
                    <span
                      key={`${u.at}-${i}`}
                      className="block font-mono break-all"
                      data-snapshot-id={u.snapshot_id ?? ''}
                    >
                      {formatWhen(u.at, t, i18n.language)} · {u.session_id}
                      {u.turn_id ? ` · ${t('uiLeftovers:memory.turnId', { id: u.turn_id })}` : ''}
                      {u.snapshot_id ? ` · ${t('uiLeftovers:memory.snapshotId', { id: u.snapshot_id })}` : ''}
                      {u.reason ? ` · ${u.reason}` : ''}
                    </span>
                  ))}
            </dd>
          </dl>
        </details>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground pointer-coarse:size-11"
          disabled={busy}
          title={
            memory.pinned
              ? t('settings:memoryPage.unpin')
              : t('settings:memoryPage.pin')
          }
          aria-label={
            memory.pinned
              ? t('settings:memoryPage.unpinAria')
              : t('settings:memoryPage.pinAria')
          }
          onClick={() => void onTogglePin(memory)}
        >
          {memory.pinned ? (
            <PinOff aria-hidden />
          ) : (
            <Pin aria-hidden />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground pointer-coarse:size-11"
          disabled={busy}
          title={t('common:edit')}
          aria-label={t('settings:memoryPage.editAria')}
          onClick={() => onEdit(memory)}
        >
          <Icon name="x-edit" size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground pointer-coarse:size-11"
          disabled={busy}
          title={t('settings:memoryPage.forget')}
          aria-label={t('settings:memoryPage.forgetAria')}
          onClick={() => void onForget(memory)}
        >
          <Icon name="x-trash" size={16} />
        </Button>
      </div>
    </li>
  )
}
