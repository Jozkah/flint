import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  useBrowserAgentPrompt,
  type DomainAnswer,
  type DomainScope,
} from '@/hooks/useBrowserAgentPrompt'

const SCOPES: DomainScope[] = ['once', 'session', 'always']

/** Hosts that are a domain name (not an address), so subdomains make sense. */
const hasSubdomains = (host: string) =>
  host.includes('.') && !host.includes(':') && !/^[\d.]+$/.test(host)

/**
 * The first-visit question for the assistant's browser. Shown over everything
 * (the native browser pane hides itself while a dialog is open), one request
 * at a time, with the full address visible: a long query string is how a page
 * would carry something out of the conversation.
 */
export function BrowserDomainDialog() {
  const { t } = useTranslation()
  const head = useBrowserAgentPrompt((s) => s.queue[0])
  const waiting = useBrowserAgentPrompt((s) => Math.max(0, s.queue.length - 1))
  const [scope, setScope] = useState<DomainScope>('once')
  const [subdomains, setSubdomains] = useState(false)

  const headId = head?.id
  useEffect(() => {
    setScope('once')
    setSubdomains(false)
  }, [headId])

  if (!head) return null
  const answer = (decision: DomainAnswer['decision']) =>
    useBrowserAgentPrompt
      .getState()
      .answer(head.id, { decision, scope, subdomains })
  const base = head.host.replace(/^www\./, '')
  const wants = t(`browser-agent:domain.wants.${head.tool}`, {
    defaultValue: head.tool,
  })

  return (
    <Dialog open onOpenChange={(open) => !open && answer('deny')}>
      <DialogContent data-testid="browser-domain-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t('browser-agent:domain.title', { host: head.host })}
          </DialogTitle>
          <DialogDescription>
            {t('browser-agent:domain.description')}
          </DialogDescription>
        </DialogHeader>

        <dl className="grid gap-3 text-sm">
          <div className="grid gap-1">
            <dt className="text-xs text-muted-foreground">
              {t('browser-agent:domain.wantsLabel')}
            </dt>
            <dd>
              {wants}
              {head.origin && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {t('browser-agent:domain.origin', { origin: head.origin })}
                </span>
              )}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-xs text-muted-foreground">
              {t('browser-agent:domain.urlLabel')}
            </dt>
            <dd
              data-testid="browser-domain-url"
              className="max-h-28 overflow-y-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all select-text"
            >
              {head.url}
            </dd>
            <p className="text-xs text-muted-foreground">
              {t('browser-agent:domain.urlHint')}
            </p>
          </div>
        </dl>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-xs text-muted-foreground">
            {t('browser-agent:domain.scopeLabel')}
          </legend>
          <RadioGroup
            value={scope}
            onValueChange={(v) => setScope(v as DomainScope)}
          >
            {SCOPES.map((s) => (
              <label key={s} className="flex items-start gap-2 text-sm">
                <RadioGroupItem
                  value={s}
                  data-testid={`browser-domain-scope-${s}`}
                  className="mt-0.5"
                />
                <span>
                  {t(`browser-agent:domain.${s}`)}
                  {s !== 'session' && (
                    <span className="block text-xs text-muted-foreground">
                      {t(`browser-agent:domain.${s}Hint`)}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </RadioGroup>
          {hasSubdomains(head.host) && (
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="browser-domain-subdomains"
                checked={subdomains}
                onChange={(e) => setSubdomains(e.target.checked)}
              />
              {t('browser-agent:domain.subdomains', { base })}
            </label>
          )}
        </fieldset>

        <p className="text-xs text-muted-foreground">
          {t('browser-agent:domain.warning')}
        </p>

        <DialogFooter className="sm:items-center">
          {waiting > 0 && (
            <span className="text-xs text-muted-foreground sm:mr-auto">
              {t('browser-agent:domain.more', { count: waiting })}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            data-testid="browser-domain-never"
            onClick={() => answer('never')}
          >
            {t('browser-agent:domain.never')}
          </Button>
          <Button
            variant="outline"
            data-testid="browser-domain-deny"
            onClick={() => answer('deny')}
          >
            {t('browser-agent:domain.deny')}
          </Button>
          <Button
            data-testid="browser-domain-allow"
            onClick={() => answer('allow')}
          >
            {t('browser-agent:domain.allow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
