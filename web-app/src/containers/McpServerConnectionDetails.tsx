/* eslint-disable react-refresh/only-export-components */
import { OctagonAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { StatusChip, type StatusTone } from '@/containers/StatusChip'
import type {
  McpConnectionSnapshot,
  McpConnectionState,
  McpNextStep,
} from '@/lib/mcpConnectionState'
import type {
  McpAccessItem,
  McpServerProfile,
  McpSetupRequirement,
} from '@/lib/mcpServerProfile'

/**
 * Per-server status, failure and explanation blocks for the MCP settings list.
 *
 * Everything shown is derived by `mcpConnectionState` and `mcpServerProfile`;
 * this component only chooses words. Literal translation keys are used
 * throughout so the i18n key scan can check them.
 */

const TONE: Record<McpConnectionState, StatusTone> = {
  'not-installed': 'neutral',
  disabled: 'neutral',
  connecting: 'progress',
  connected: 'success',
  'needs-authorization': 'warning',
  failed: 'destructive',
  'not-connected': 'warning',
}

function useStateLabel() {
  const { t } = useTranslation()
  return (state: McpConnectionState): string => {
    switch (state) {
      case 'not-installed':
        return t('mcp-servers:connection.state.notInstalled')
      case 'disabled':
        return t('mcp-servers:connection.state.disabled')
      case 'connecting':
        return t('mcp-servers:connection.state.connecting')
      case 'connected':
        return t('mcp-servers:connection.state.connected')
      case 'needs-authorization':
        return t('mcp-servers:connection.state.needsAuthorization')
      case 'failed':
        return t('mcp-servers:connection.state.failed')
      case 'not-connected':
        return t('mcp-servers:connection.state.notConnected')
    }
  }
}

function useNextStepLabel() {
  const { t } = useTranslation()
  return (step: McpNextStep): string => {
    switch (step) {
      case 'check-command':
        return t('mcp-servers:connection.nextStep.checkCommand')
      case 'check-url':
        return t('mcp-servers:connection.nextStep.checkUrl')
      case 'authorize':
        return t('mcp-servers:connection.nextStep.authorize')
      case 'retry':
        return t('mcp-servers:connection.nextStep.retry')
    }
  }
}

export function mcpServerErrorId(serverName: string): string {
  return `mcp-server-error-${serverName.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

export function McpServerStatus({
  serverName,
  snapshot,
  toolNames,
  canAuthorize,
  onRetry,
  onAuthorize,
  compact = false,
}: {
  serverName: string
  snapshot: McpConnectionSnapshot
  /**
   * Tool names when known; `undefined` while loading; `null` when the list
   * could not be read (nothing is claimed about tools then).
   */
  toolNames: string[] | null | undefined
  /** Whether an interactive sign-in is possible for this server. */
  canAuthorize: boolean
  onRetry: () => void
  onAuthorize: () => void
  /**
   * Tile layout: the chip without its label and no tools sentence, since the
   * tile shows the tool count and names itself.
   */
  compact?: boolean
}) {
  const { t } = useTranslation()
  const stateLabel = useStateLabel()
  const nextStepLabel = useNextStepLabel()
  const { state, failure, nextStep } = snapshot

  return (
    <div className={compact ? 'flex flex-col gap-2' : 'mt-2 flex flex-col gap-1'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={compact ? 'sr-only' : 'text-fg-2'}>
          {t('mcp-servers:connection.statusLabel')}
        </span>
        <StatusChip
          role="status"
          aria-live="polite"
          data-testid={`mcp-status-${serverName}`}
          tone={TONE[state]}
          pulse={state === 'connecting'}
        >
          {stateLabel(state)}
        </StatusChip>
      </div>

      {failure && (
        <div
          role="alert"
          id={mcpServerErrorId(serverName)}
          className="rounded-lg bg-destructive-tint px-3 py-2 text-xs"
        >
          <p className="flex items-start gap-2 break-words text-destructive">
            <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{failure.message}</span>
          </p>
          {nextStep && (
            <p className="mt-1 text-fg-2">
              {nextStepLabel(nextStep)}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-3">
            {nextStep === 'authorize' && canAuthorize ? (
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0"
                onClick={onAuthorize}
              >
                {t('mcp-servers:auth.authenticate')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0"
                onClick={onRetry}
              >
                {t('mcp-servers:connection.retry')}
              </Button>
            )}
          </div>
        </div>
      )}

      {!compact && !(state === 'connected' && toolNames === null) && (
        <p className="text-xs text-fg-2">
          {state === 'connected'
            ? toolNames === undefined
              ? t('mcp-servers:connection.toolsLoading')
              : toolNames!.length === 0
                ? t('mcp-servers:connection.toolsNone')
                : t('mcp-servers:connection.toolsAvailable', {
                    count: toolNames!.length,
                    names: toolNames!.join(', '),
                  })
            : t('mcp-servers:connection.toolsWhenConnected')}
        </p>
      )}
    </div>
  )
}

function AccessLine({ item }: { item: McpAccessItem }) {
  const { t } = useTranslation()
  switch (item.kind) {
    case 'runs-command':
      return (
        <li className="break-all">
          {t('mcp-servers:details.accessCommand', {
            command: [item.command, ...item.args].join(' '),
          })}
        </li>
      )
    case 'env-vars':
      return (
        <li className="break-all">
          {t('mcp-servers:details.accessEnv', { names: item.names.join(', ') })}
        </li>
      )
    case 'sends-headers':
      return (
        <li className="break-all">
          {t('mcp-servers:details.accessHeaders', {
            names: item.names.join(', '),
          })}
        </li>
      )
    case 'connects-to':
      return (
        <li className="break-all">
          {t('mcp-servers:details.accessHost', { host: item.host })}
        </li>
      )
  }
}

function SetupLine({
  item,
  authStateLabel,
}: {
  item: McpSetupRequirement
  authStateLabel: string | undefined
}) {
  const { t } = useTranslation()
  switch (item.kind) {
    case 'authorization':
      return (
        <li>
          {t('mcp-servers:details.setupAuthorization', {
            state: authStateLabel ?? item.state,
          })}
        </li>
      )
    case 'browser-extension':
      return <li>{t('mcp-servers:details.setupBrowserExtension')}</li>
    case 'missing-command':
      return <li>{t('mcp-servers:details.setupMissingCommand')}</li>
    case 'missing-url':
      return <li>{t('mcp-servers:details.setupMissingUrl')}</li>
  }
}

export function McpServerDetails({
  profile,
  toolNames,
  authStateLabel,
  serverName,
  onGenerateDescription,
}: {
  profile: McpServerProfile
  toolNames: string[] | null | undefined
  /** Translated auth state, for the sign-in requirement line. */
  authStateLabel?: string
  serverName?: string
  /** Opens the AI description generator for this server. */
  onGenerateDescription?: () => void
}) {
  const { t } = useTranslation()
  const host = profile.host ?? ''

  const runsWhere =
    profile.runsWhere === 'local-process'
      ? t('mcp-servers:details.runsWhereLocalProcess')
      : profile.runsWhere === 'local-endpoint'
        ? t('mcp-servers:details.runsWhereLocalEndpoint', { host })
        : profile.runsWhere === 'remote-service'
          ? t('mcp-servers:details.runsWhereRemoteService', { host })
          : t('mcp-servers:details.runsWhereUnresolved', { host })

  const heading = 'text-xs font-semibold text-foreground'

  return (
    // Native <details>: keyboard operable (Enter/Space on the summary) and
    // announces expanded state without extra wiring. Nothing here is
    // reachable only by hovering.
    <details className="mt-2 group">
      <summary className="flex min-h-11 w-fit cursor-pointer items-center rounded-sm text-xs font-medium text-acc-text focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-fine:min-h-0">
        {t('mcp-servers:details.toggle')}
      </summary>
      <div className="mt-2 flex flex-col gap-3 rounded-lg bg-muted p-3 text-xs text-fg-2 shadow-[inset_0_0_0_0.8px_var(--border)]">
        <section>
          <div className="flex items-center justify-between gap-2">
            <h3 className={heading}>{t('mcp-servers:details.whatItDoes')}</h3>
            {onGenerateDescription && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs pointer-coarse:h-11"
                aria-label={t('mcp-servers:details.generateLabel', {
                  serverName: serverName ?? '',
                })}
                onClick={onGenerateDescription}
              >
                {t('mcp-servers:details.generate')}
              </Button>
            )}
          </div>
          <p>{profile.description ?? t('mcp-servers:details.noDescription')}</p>
        </section>

        <section>
          <h3 className={heading}>{t('mcp-servers:details.runsWhere')}</h3>
          <p className="break-all">{runsWhere}</p>
          <p>
            {profile.contactsExternalServices === 'yes'
              ? t('mcp-servers:details.externalYes')
              : t('mcp-servers:details.externalDepends')}
          </p>
        </section>

        <section>
          <h3 className={heading}>{t('mcp-servers:details.access')}</h3>
          {profile.requiredAccess.length === 0 ? (
            <p>{t('mcp-servers:details.accessNone')}</p>
          ) : (
            <ul className="list-disc pl-4">
              {profile.requiredAccess.map((item) => (
                <AccessLine key={item.kind} item={item} />
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className={heading}>{t('mcp-servers:details.appliesTo')}</h3>
          <p>{t('mcp-servers:connection.appliesToChats')}</p>
        </section>

        <section>
          <h3 className={heading}>{t('mcp-servers:details.setup')}</h3>
          {profile.setupRequirements.length === 0 ? (
            <p>{t('mcp-servers:details.setupNone')}</p>
          ) : (
            <ul className="list-disc pl-4">
              {profile.setupRequirements.map((item) => (
                <SetupLine
                  key={item.kind}
                  item={item}
                  authStateLabel={authStateLabel}
                />
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className={heading}>{t('mcp-servers:details.usage')}</h3>
          <p>{t('mcp-servers:details.usageExample')}</p>
          {toolNames && toolNames.length > 0 && (
            <p className="break-words">
              {t('mcp-servers:details.toolNames', {
                names: toolNames.join(', '),
              })}
            </p>
          )}
        </section>

        <section>
          <h3 className={heading}>{t('mcp-servers:details.effects')}</h3>
          <ul className="list-disc pl-4">
            <li>{t('mcp-servers:details.effectDisable')}</li>
            {profile.transport !== 'stdio' && (
              <li>{t('mcp-servers:details.effectClearAuth')}</li>
            )}
            <li>{t('mcp-servers:details.effectRemove')}</li>
          </ul>
        </section>
      </div>
    </details>
  )
}
