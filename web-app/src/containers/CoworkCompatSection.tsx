import { useTranslation } from '@/i18n/react-i18next-compat'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import {
  instructionOrder,
  type CompatComponent,
  type CompatibilityManifest,
} from '@/lib/claudeCompat'

/**
 * What Jan found in this folder's Claude configuration, and what it did about
 * each part.
 *
 * The section is a matrix rather than a status light because "compatible" is
 * not one fact. A repository can have instructions Jan reads, a skill it
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
    <section
      aria-label={t('common:claudeCompat.title')}
      data-testid="cowork-compat"
      className="flex flex-col gap-2 text-xs"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-medium text-main-view-fg">
            {t('common:claudeCompat.title')}
          </h3>
          <p className="text-main-view-fg/60">
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
      <p className="text-main-view-fg/60">
        {hasFolder
          ? t('common:claudeCompat.grantsNothing')
          : t('common:claudeCompat.needsFolder')}
      </p>

      {byType.length === 0 ? (
        <p className="text-main-view-fg/70">
          {t('common:claudeCompat.nothingFound')}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {instructionNames.length > 0 ? (
            <p className="text-main-view-fg/70">
              {t('common:claudeCompat.precedence')}:{' '}
              {instructionOrder(instructionNames).join(' › ')}
            </p>
          ) : null}

          {byType.map((group) => (
            <div key={group.type} className="flex flex-col gap-1">
              <span className="text-main-view-fg/70">
                {t(`common:claudeCompat.type.${group.type}`)}
              </span>
              <ul className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start justify-between gap-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-main-view-fg/90">
                        {item.name}
                      </span>
                      <span className="block text-main-view-fg/60">
                        {t(`common:claudeCompat.state.${item.state}`)}
                        {item.reason ? ` · ${item.reason}` : ''}
                      </span>
                      {item.type === 'mcp' ? (
                        <span className="block text-main-view-fg/60">
                          {item.dependencies && item.dependencies.length > 0
                            ? `${t('common:claudeCompat.mcpEnv')}: ${item.dependencies.join(', ')}`
                            : t('common:claudeCompat.mcpNoEnv')}
                        </span>
                      ) : null}
                    </span>
                    {/* Offered only where consent is the thing standing in the
                        way. A server Jan refuses to confine has no button,
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
    </section>
  )
}
