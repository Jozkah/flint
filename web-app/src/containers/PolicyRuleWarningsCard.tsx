import { useEffect, useState } from 'react'
import { invokeCommand } from '@/lib/backend'
import { AlertTriangle } from 'lucide-react'
import { Card } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { hasDesktopBackend } from '@/lib/desktopBackend'

export type RuleWarning = {
  list: string
  rule: string
  kind: 'malformed' | 'unknown-tool' | 'ineffective-resource' | 'unsafe-wildcard'
  reason: string
}

export type ProjectRuleWarnings = {
  project: string
  folder: string
  warnings: RuleWarning[]
}

/** A dropped or ineffective deny/ask rule is a restriction that is not there. */
export const weakensRestriction = (w: RuleWarning) =>
  w.list === 'deny' || w.list === 'ask'

/**
 * Rules in a project's `agent.toml` that were dropped (typo) or can never
 * fire. The policy still loads, so without this a mistyped `deny` just
 * disappears. Renders nothing when every project's rules are sound.
 */
export function PolicyRuleWarningsCard() {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<ProjectRuleWarnings[]>([])

  useEffect(() => {
    if (!hasDesktopBackend()) return
    let live = true
    invokeCommand<ProjectRuleWarnings[]>('agent_policy_rule_warnings', {})
      .then((rows) => {
        if (live && Array.isArray(rows)) setProjects(rows)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  if (projects.length === 0) return null

  return (
    <Card
      title={t('permissions:ruleWarnings.title')}
      description={t('permissions:ruleWarnings.description')}
      data-testid="policy-rule-warnings-card"
    >
      <div role="alert" className="flex flex-col gap-4">
        {projects.map((p) => (
          <div key={p.folder} className="space-y-2">
            <p className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium break-words">
              {p.project}
            </p>
            <ul className="flex flex-col">
              {p.warnings.map((w, i) => (
                <li
                  key={`${w.list}-${w.rule}-${i}`}
                  data-testid="policy-rule-warning-row"
                  className="flex items-start gap-2 border-b border-dashed border-border px-0.5 py-[11px] last:border-b-0"
                >
                  <AlertTriangle
                    className={`mt-0.5 size-4 shrink-0 ${weakensRestriction(w) ? 'text-destructive' : 'text-amber-500'}`}
                    aria-hidden
                  />
                  <div className="min-w-0 space-y-1 text-[length:calc(var(--ui-font-base)*0.8125)]">
                    <p className="break-words">
                      <code>{w.list}</code> · <code>{w.rule}</code>
                    </p>
                    <p className="break-words text-muted-foreground">{w.reason}</p>
                    {weakensRestriction(w) && (
                      <p className="font-medium text-destructive">
                        {t('permissions:ruleWarnings.notProtecting')}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  )
}
