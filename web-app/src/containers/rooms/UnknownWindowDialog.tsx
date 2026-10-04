import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useUnknownWindowPrompt } from '@/hooks/useUnknownWindowPrompt'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { usableContextValue } from '@/lib/modelCapabilities'
import { modelKey } from '@/lib/modelReplace'
import { FALLBACK_CONTEXT_WINDOW } from '@/lib/rooms/context'
import {
  distinctModels,
  rememberAcceptedWindows,
  saveMaxContextTokens,
} from '@/lib/rooms/unknownWindows'

/**
 * Asks, before a room starts, about each model whose context window is unknown:
 * set Max Context Tokens now, or knowingly use the safe default. The room only
 * starts once every model is settled; cancelling leaves the room as it was.
 */
export function UnknownWindowDialog() {
  const { t } = useTranslation()
  const request = useUnknownWindowPrompt((s) => s.request)
  const answer = useUnknownWindowPrompt((s) => s.answer)
  const [values, setValues] = useState<Record<string, string>>({})
  const [useDefault, setUseDefault] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setValues({})
    setUseDefault({})
  }, [request])

  if (!request) return null
  const models = distinctModels(request.entries)
  const settled = (key: string) =>
    useDefault[key] === true || usableContextValue(values[key]) != null
  const ready = models.every((m) => settled(modelKey(m)))

  const confirm = () => {
    const accepted = []
    for (const m of models) {
      const key = modelKey(m)
      const n = useDefault[key] ? null : usableContextValue(values[key])
      if (n != null) saveMaxContextTokens(m, n)
      else accepted.push(m)
    }
    rememberAcceptedWindows(accepted)
    answer(true)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('rooms:unknownWindow.title')}</DialogTitle>
          <DialogDescription>
            {t('rooms:unknownWindow.description', {
              subject: request.subject,
              window: FALLBACK_CONTEXT_WINDOW.toLocaleString('en-US'),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {models.map((m) => {
            const key = modelKey(m)
            const who = request.entries
              .filter((e) => modelKey(e.model) === key)
              .map((e) => e.name)
              .join(', ')
            const inputId = `unknown-window-${key}`
            return (
              <div key={key} className="flex flex-col gap-1.5">
                <label htmlFor={inputId} className="text-xs font-medium text-foreground">
                  {m.provider} / {m.id}
                </label>
                <span className="text-xs text-muted-foreground">
                  {t('rooms:unknownWindow.usedBy', { names: who })}
                </span>
                <div className="flex items-center gap-2">
                  <Input
                    id={inputId}
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    disabled={useDefault[key] === true}
                    placeholder={t('rooms:unknownWindow.placeholder')}
                    value={values[key] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                  <Button
                    variant={useDefault[key] ? 'default' : 'outline'}
                    aria-pressed={useDefault[key] === true}
                    onClick={() => setUseDefault((prev) => ({ ...prev, [key]: !prev[key] }))}
                  >
                    {t('rooms:unknownWindow.useDefault', {
                      window: FALLBACK_CONTEXT_WINDOW.toLocaleString('en-US'),
                    })}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => answer(false)}>
            {t('rooms:unknownWindow.cancel')}
          </Button>
          <Button disabled={!ready} onClick={confirm}>
            {t('rooms:unknownWindow.continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
