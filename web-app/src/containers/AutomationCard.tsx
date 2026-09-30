import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAutomationSettings } from '@/hooks/useAutomationSettings'

/**
 * The two per-message decisions Flint makes for you that had no switch of
 * their own. The third, the work profile, is the card below this one.
 */
export function AutomationCard() {
  const { t } = useTranslation()
  const routeAssistants = useAutomationSettings((s) => s.routeAssistants)
  const activateSkills = useAutomationSettings((s) => s.activateSkills)
  return (
    <Card title={t('common:jev.automationTitle')}>
      <CardItem
        anchor="settings-jev-route"
        align="start"
        title={t('common:jev.routeToggle')}
        description={<p>{t('common:jev.routeExplained')}</p>}
        actions={
          <Switch
            data-testid="route-assistants-toggle"
            aria-label={t('common:jev.routeToggle')}
            checked={routeAssistants}
            onCheckedChange={(on) =>
              useAutomationSettings.getState().setRouteAssistants(on)
            }
          />
        }
      />
      <CardItem
        anchor="settings-jev-activate"
        align="start"
        title={t('common:jev.activateToggle')}
        description={<p>{t('common:jev.activateExplained')}</p>}
        actions={
          <Switch
            data-testid="activate-skills-toggle"
            aria-label={t('common:jev.activateToggle')}
            checked={activateSkills}
            onCheckedChange={(on) =>
              useAutomationSettings.getState().setActivateSkills(on)
            }
          />
        }
      />
    </Card>
  )
}
