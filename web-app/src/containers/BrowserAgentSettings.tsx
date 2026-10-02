import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import {
  clearBrowserGrants,
  listBrowserRules,
  removeBrowserRule,
  setBrowserRule,
  type BrowserRule,
} from '@/lib/browserAgentRules'
import { errorText } from '@/lib/errorText'

/**
 * Settings for the assistant's use of the built-in browser pane: the on/off
 * switch, the action cap, and the list of sites the user allowed always or
 * blocked, which is where an "Always allow" is taken back.
 */
export function BrowserAgentSettings() {
  const { t } = useTranslation()
  const enabled = useAgentToolsConfig((s) => s.browserAgentEnabled)
  const setEnabled = useAgentToolsConfig((s) => s.setBrowserAgentEnabled)
  const maxActions = useAgentToolsConfig((s) => s.browserAgentMaxActions)
  const setMaxActions = useAgentToolsConfig((s) => s.setBrowserAgentMaxActions)
  const pointer = useAgentToolsConfig((s) => s.browserAgentPointer)
  const setPointer = useAgentToolsConfig((s) => s.setBrowserAgentPointer)
  const reduceMotion = useAgentToolsConfig((s) => s.browserAgentReduceMotion)
  const setReduceMotion = useAgentToolsConfig(
    (s) => s.setBrowserAgentReduceMotion
  )

  const [rules, setRules] = useState<BrowserRule[]>([])
  const [pattern, setPattern] = useState('')
  const [verdict, setVerdict] = useState<BrowserRule['verdict']>('allow')
  const [privateOk, setPrivateOk] = useState(false)

  const refresh = useCallback(() => {
    listBrowserRules()
      .then(setRules)
      .catch(() => setRules([]))
  }, [])
  useEffect(refresh, [refresh])

  const remove = async (rule: BrowserRule) => {
    try {
      await removeBrowserRule(rule.pattern)
      toast.success(t('browser-agent:settings.removed'))
      refresh()
    } catch (e) {
      toast.error(
        t('browser-agent:settings.removeFailed', { error: errorText(e) })
      )
    }
  }

  const add = async () => {
    try {
      await setBrowserRule(pattern, verdict, verdict === 'allow' && privateOk)
      toast.success(t('browser-agent:settings.added'))
      setPattern('')
      setPrivateOk(false)
      refresh()
    } catch (e) {
      toast.error(
        t('browser-agent:settings.addFailed', { error: errorText(e) })
      )
    }
  }

  return (
    <>
      <Card title={t('browser-agent:settings.title')} data-testid="browser-agent-settings">
        <CardItem
          anchor="settings-agent-tools-browser"
          title={t('browser-agent:settings.enabled')}
          description={t('browser-agent:settings.enabledDesc')}
          align="start"
          actions={
            <Switch
              data-testid="browser-agent-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          }
        />
        <CardItem
          title={t('browser-agent:settings.maxActions')}
          description={t('browser-agent:settings.maxActionsDesc')}
          actions={
            <Input
              type="number"
              min={1}
              max={200}
              aria-label={t('browser-agent:settings.maxActions')}
              data-testid="browser-agent-max-actions"
              className="w-[90px] text-right tabular-nums"
              disabled={!enabled}
              defaultValue={maxActions}
              key={maxActions}
              onBlur={(e) => setMaxActions(Number(e.currentTarget.value))}
            />
          }
        />
        <CardItem
          title={t('browser-agent:settings.pointer')}
          description={t('browser-agent:settings.pointerDesc')}
          align="start"
          actions={
            <Switch
              data-testid="browser-agent-pointer"
              checked={pointer}
              disabled={!enabled}
              onCheckedChange={setPointer}
            />
          }
        />
        <CardItem
          title={t('browser-agent:settings.reduceMotion')}
          description={t('browser-agent:settings.reduceMotionDesc')}
          actions={
            <select
              aria-label={t('browser-agent:settings.reduceMotion')}
              data-testid="browser-agent-reduce-motion"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              disabled={!enabled || !pointer}
              value={reduceMotion}
              onChange={(e) =>
                setReduceMotion(e.target.value as 'system' | 'on' | 'off')
              }
            >
              <option value="system">
                {t('browser-agent:settings.reduceSystem')}
              </option>
              <option value="on">{t('browser-agent:settings.reduceOn')}</option>
              <option value="off">{t('browser-agent:settings.reduceOff')}</option>
            </select>
          }
        />
        <CardItem
          title={t('browser-agent:settings.forgetGrants')}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void clearBrowserGrants().catch(() => {})}
            >
              {t('browser-agent:settings.forgetGrants')}
            </Button>
          }
        />
      </Card>

      <Card
        title={t('browser-agent:settings.rulesTitle')}
        description={t('browser-agent:settings.rulesDesc')}
        data-testid="browser-agent-rules"
      >
        {rules.length === 0 ? (
          <CardItem description={t('browser-agent:settings.empty')} />
        ) : (
          rules.map((rule) => (
            <CardItem
              key={rule.pattern}
              title={
                <span className="font-mono text-sm" data-testid="browser-rule-pattern">
                  {rule.pattern}
                </span>
              }
              description={[
                t(`browser-agent:settings.${rule.verdict}`),
                rule.private_ok ? t('browser-agent:settings.privateOk') : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="browser-rule-remove"
                  aria-label={`${t('browser-agent:settings.remove')} ${rule.pattern}`}
                  onClick={() => void remove(rule)}
                >
                  {t('browser-agent:settings.remove')}
                </Button>
              }
            />
          ))
        )}
        <CardItem
          column
          align="start"
          title={t('browser-agent:settings.addLabel')}
          actions={
            <form
              className="grid w-full gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void add()
              }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-[200px] flex-1 font-mono"
                  data-testid="browser-rule-input"
                  aria-label={t('browser-agent:settings.addLabel')}
                  placeholder={t('browser-agent:settings.addPlaceholder')}
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                />
                <select
                  aria-label={t('browser-agent:settings.addVerdict')}
                  data-testid="browser-rule-verdict"
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={verdict}
                  onChange={(e) =>
                    setVerdict(e.target.value as BrowserRule['verdict'])
                  }
                >
                  <option value="allow">{t('browser-agent:settings.allow')}</option>
                  <option value="deny">{t('browser-agent:settings.deny')}</option>
                </select>
                <Button
                  type="submit"
                  size="sm"
                  data-testid="browser-rule-add"
                  disabled={!pattern.trim()}
                >
                  {t('browser-agent:settings.add')}
                </Button>
              </div>
              {verdict === 'allow' && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    data-testid="browser-rule-private"
                    checked={privateOk}
                    onChange={(e) => setPrivateOk(e.target.checked)}
                  />
                  {t('browser-agent:settings.addPrivate')}
                </label>
              )}
            </form>
          }
        />
      </Card>
    </>
  )
}
