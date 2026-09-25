import { useTranslation } from '@/i18n/react-i18next-compat'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import {
  instructionOrder,
  type CompatComponent,
  type CompatibilityManifest,
} from '@/lib/claudeCompat'
import { errorText } from '@/lib/errorText'

/**
 * What Flint found in this folder's Claude configuration, and what it did about
 * each part.
 *
 * The section is a matrix rather than a status light because "compatible" is
 * not one fact. A repository can have instructions Flint reads, a skill it
 * refuses because a resource points outside the folder, an agent missing a
 * tool, a remote server waiting for approval and a hook that will never run —
 * all at once. Showing a single "compatible" badge over that would be the
 * lie this whole surface exists to avoid.
 *
 * Every state is words, not colour alone, and the reason is shown wherever the
 * reason is the whole content.
 */

const ORDER: CompatComponent['type'][] = [
  'instructions',
  'skill',
  'agent',
  'mcp',
  'command',
  'hook',
  'plugin',
]

export function CoworkCompatSection({
  manifest,
  hasFolder,
  onToggle,
  onMcpConsent,
}: {
  manifest: CompatibilityManifest
  hasFolder: boolean
  onToggle: (enabled: boolean) => void
  /** Allow or withdraw one MCP server. */
  onMcpConsent: (server: string, allowed: boolean) => void
}) {
  const { t } = useTranslation()
  const byType = ORDER.map((type) => ({
    type,
    items: manifest.components.filter((one) => one.type === type),
  })).filter((group) => group.items.length > 0)

  const instructionNames = manifest.components
    .filter((one) => one.type === 'instructions' && one.state === 'active')
    .map((one) => one.name)

  return (
    // Still its own labelled region -- a <details> is not a landmark -- with
    // the body collapsed by default, because this is configuration and it was
    // sitting open in the conversation column under every message.
    <section
      aria-label={t('common:claudeCompat.title')}
      data-testid="cowork-compat"
      className="rounded-[10px] border-[0.8px] border-border bg-card px-3 py-2.5 text-xs"
    >
      <details className="flex flex-col gap-2">
      <summary className="cursor-pointer list-none rounded-sm text-[13px] font-medium text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40">
        {t('common:claudeCompat.title')}
      </summary>
      <header className="mt-2 flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="sr-only">
            {t('common:claudeCompat.title')}
          </h3>
          <p className="text-muted-foreground">
            {t('common:claudeCompat.subtitle')}
          </p>
        </div>
        <Switch
          checked={manifest.enabled}
          disabled={!hasFolder}
          aria-label={t('common:claudeCompat.enable')}
          onCheckedChange={onToggle}
        />
      </header>

      {/* Said next to the switch, where the decision is made: someone turning
          this on is entitled to know it is not also a permission change. */}
      <p className="text-muted-foreground">
        {hasFolder
          ? t('common:claudeCompat.grantsNothing')
          : t('common:claudeCompat.needsFolder')}
      </p>

      {byType.length === 0 ? (
        <p className="text-fg-2">
          {t('common:claudeCompat.nothingFound')}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {instructionNames.length > 0 ? (
            <p className="text-fg-2">
              {t('common:claudeCompat.precedence')}:{' '}
              {instructionOrder(instructionNames).join(' › ')}
            </p>
          ) : null}

          {byType.map((group) => (
            <div key={group.type} className="flex flex-col gap-1">
              <span className="text-fg-2">
                {t(`common:claudeCompat.type.${group.type}`)}
              </span>
              <ul className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start justify-between gap-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-foreground">
                        {item.name}
                      </span>
                      <span className="block text-muted-foreground">
                        {t(`common:claudeCompat.state.${item.state}`)}
                        {/* Through the formatter at the point of display:
                            `reason` is typed as a string but arrives from a
                            rejected command, and an object here is what put
                            "[object Object]" on screen. */}
                        {item.reason ? ` · ${errorText(item.reason)}` : ''}
                      </span>
                      {item.type === 'mcp' ? (
                        <span className="block text-muted-foreground">
                          {item.dependencies && item.dependencies.length > 0
                            ? `${t('common:claudeCompat.mcpEnv')}: ${item.dependencies.join(', ')}`
                            : t('common:claudeCompat.mcpNoEnv')}
                        </span>
                      ) : null}
                    </span>
                    {/* Offered only where consent is the thing standing in the
                        way. A server Flint refuses to confine has no button,
                        because there is nothing the user could consent to. */}
                    {item.type === 'mcp' &&
                    (item.state === 'consent-required' ||
                      item.state === 'active') ? (
                      <Button
                        size="sm"
                        variant="link"
                        className="h-auto shrink-0 p-0 text-xs"
                        onClick={() =>
                          onMcpConsent(item.name, item.state !== 'active')
                        }
                      >
                        {item.state === 'active'
                          ? t('common:claudeCompat.mcpWithdraw')
                          : t('common:claudeCompat.mcpAllow')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      </details>
    </section>
  )
}
