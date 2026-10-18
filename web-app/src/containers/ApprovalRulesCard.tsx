import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { MiddleText } from '@/components/ui/middle-text'
import { hasDesktopBackend } from '@/lib/desktopBackend'
import { errorText } from '@/lib/errorText'
import {
  answerDeferred,
  describeScope,
  discardDeferred,
  listDeferred,
  listScopedRules,
  revokeScopedRule,
  type DeferredApproval,
  type ScopedRule,
} from '@/lib/approvalScopes'

const ROW =
  'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-dashed border-border px-0.5 py-[11px] last:border-b-0 [&>:first-child]:flex-[1_1_10rem]'
const EMPTY = 'py-3 text-[13px] text-muted-foreground'
const ACTION = 'shrink-0 pointer-coarse:h-11'

/** A deadline in the app's language, not the system's. */
const whenText = (secs: number, language?: string) =>
  new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(secs * 1000))

/**
 * What "Always" was narrowed to, one row per rule with a way to take it back,
 * and the questions runs put off to be answered later.
 */
export function ApprovalRulesCard() {
  const { t, i18n } = useTranslation()
  const [rules, setRules] = useState<ScopedRule[] | null>(null)
  const [waiting, setWaiting] = useState<DeferredApproval[]>([])
  // A page served to a browser has no backend to ask.
  const desktop = hasDesktopBackend()

  const reload = useCallback(async () => {
    if (!desktop) return
    try {
      setRules(await listScopedRules())
    } catch (e) {
      toast.error(`${t('permissions:rules.loadFailed')}: ${errorText(e)}`)
      setRules([])
    }
    try {
      setWaiting(await listDeferred(false))
    } catch (e) {
      toast.error(`${t('permissions:deferred.loadFailed')}: ${errorText(e)}`)
      setWaiting([])
    }
  }, [t, desktop])

  useEffect(() => {
    void reload()
  }, [reload])

  const revoke = async (rule: ScopedRule) => {
    try {
      await revokeScopedRule(rule.id)
    } catch (e) {
      toast.error(`${t('permissions:rules.revokeFailed')}: ${errorText(e)}`)
    }
    await reload()
  }

  const answer = async (item: DeferredApproval, allow: boolean) => {
    try {
      await answerDeferred(item.id, allow)
    } catch (e) {
      toast.error(`${t('permissions:deferred.answerFailed')}: ${errorText(e)}`)
    }
    await reload()
  }

  const discard = async (item: DeferredApproval) => {
    try {
      await discardDeferred(item.id)
    } catch (e) {
      toast.error(`${t('permissions:deferred.answerFailed')}: ${errorText(e)}`)
    }
    await reload()
  }

  return (
    <>
      <Card
        anchor="settings-permissions-approval-rules"
        title={t('permissions:rules.title')}
        description={t('permissions:rules.description')}
        aside={<span className="tabular-nums">{rules?.length ?? 0}</span>}
        data-testid="approval-rules-card"
      >
        {!desktop ? (
          <p className={EMPTY} data-testid="approval-rules-desktop-only">
            {t('permissions:desktopOnly')}
          </p>
        ) : !rules || rules.length === 0 ? (
          <p className={EMPTY} data-testid="approval-rules-empty">
            {t('permissions:rules.empty')}
          </p>
        ) : (
          <ul className="flex flex-col">
            {rules.map((rule) => {
              const scope = describeScope(rule.scope)
              const text = t(scope.key, scope.values)
              return (
                <li key={rule.id} className={ROW} data-testid="approval-rule-row">
                  <div className="min-w-0 space-y-1">
                    <p className="text-[13px] break-words text-foreground">
                      <code>{rule.tool}</code> · {text}
                    </p>
                    <MiddleText
                      text={t('permissions:rules.project', {
                        project: rule.project,
                      })}
                      title={rule.project}
                      className="font-mono text-xs text-muted-foreground"
                    />
                  </div>
                  <Button
                    variant="destructive"
                    className={ACTION}
                    aria-label={t('permissions:rules.revokeLabel', {
                      tool: rule.tool,
                      scope: text,
                    })}
                    onClick={() => void revoke(rule)}
                  >
                    {t('permissions:rules.revoke')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
      <Card
        anchor="settings-permissions-deferred-approvals"
        title={t('permissions:deferred.title')}
        description={t('permissions:deferred.description')}
        aside={<span className="tabular-nums">{waiting.length}</span>}
        data-testid="deferred-approvals-card"
      >
        {!desktop ? (
          <p className={EMPTY} data-testid="deferred-approvals-desktop-only">
            {t('permissions:desktopOnly')}
          </p>
        ) : waiting.length === 0 ? (
          <p className={EMPTY} data-testid="deferred-approvals-empty">
            {t('permissions:deferred.empty')}
          </p>
        ) : (
          <ul className="flex flex-col">
            {waiting.map((item) => (
              <li key={item.id} className={ROW} data-testid="deferred-approval-row">
                <div className="min-w-0 space-y-1">
                  <p className="font-mono text-xs break-words text-foreground">
                    {item.summary}
                  </p>
                  <p className="break-words text-xs text-muted-foreground">
                    {t(`permissions:deferred.status.${item.status}`)}
                    {item.session
                      ? ` · ${t('permissions:deferred.session', { session: item.session })}`
                      : ''}
                    {' · '}
                    {t('permissions:deferred.deadline', {
                      when: whenText(item.expiresAt, i18n?.language),
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {item.status === 'pending' ? (
                    <>
                      <Button
                        variant="outline"
                        className={ACTION}
                        aria-label={t('permissions:deferred.denyLabel', {
                          summary: item.summary,
                        })}
                        onClick={() => void answer(item, false)}
                      >
                        {t('permissions:deferred.deny')}
                      </Button>
                      <Button
                        className={ACTION}
                        aria-label={t('permissions:deferred.allowLabel', {
                          summary: item.summary,
                        })}
                        onClick={() => void answer(item, true)}
                      >
                        {t('permissions:deferred.allow')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      className={ACTION}
                      aria-label={t('permissions:deferred.discardLabel', {
                        summary: item.summary,
                      })}
                      onClick={() => void discard(item)}
                    >
                      {t('permissions:deferred.discard')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
