import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
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

const whenText = (secs: number) => new Date(secs * 1000).toLocaleString()

/**
 * What "Always" was narrowed to, one row per rule with a way to take it back,
 * and the questions runs put off to be answered later.
 */
export function ApprovalRulesCard() {
  const { t } = useTranslation()
  const [rules, setRules] = useState<ScopedRule[] | null>(null)
  const [waiting, setWaiting] = useState<DeferredApproval[]>([])

  const reload = useCallback(async () => {
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
  }, [t])

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
        {!rules || rules.length === 0 ? (
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
                    <p className="break-all text-[13px] text-foreground">
                      <code>{rule.tool}</code> · {text}
                    </p>
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {t('permissions:rules.project', { project: rule.project })}
                    </p>
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
        {waiting.length === 0 ? (
          <p className={EMPTY} data-testid="deferred-approvals-empty">
            {t('permissions:deferred.empty')}
          </p>
        ) : (
          <ul className="flex flex-col">
            {waiting.map((item) => (
              <li key={item.id} className={ROW} data-testid="deferred-approval-row">
                <div className="min-w-0 space-y-1">
                  <p className="break-all font-mono text-xs text-foreground">
                    {item.summary}
                  </p>
                  <p className="break-words text-xs text-muted-foreground">
                    {t(`permissions:deferred.status.${item.status}`)}
                    {item.session
                      ? ` · ${t('permissions:deferred.session', { session: item.session })}`
                      : ''}
                    {' · '}
                    {t('permissions:deferred.deadline', {
                      when: whenText(item.expiresAt),
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {item.status === 'pending' ? (
                    <>
                      <Button
                        variant="outline"
                        className={ACTION}
                        onClick={() => void answer(item, false)}
                      >
                        {t('permissions:deferred.deny')}
                      </Button>
                      <Button
                        className={ACTION}
                        onClick={() => void answer(item, true)}
                      >
                        {t('permissions:deferred.allow')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      className={ACTION}
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
