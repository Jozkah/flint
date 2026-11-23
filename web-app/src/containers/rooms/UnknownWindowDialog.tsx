import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
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
import { lookupModelsDev, type ModelsDevMatch } from '@/lib/modelsDev'
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
  const { t, i18n } = useTranslation()
  const windowText = FALLBACK_CONTEXT_WINDOW.toLocaleString(i18n?.language ?? 'en')
  const request = useUnknownWindowPrompt((s) => s.request)
  const answer = useUnknownWindowPrompt((s) => s.answer)
  const [values, setValues] = useState<Record<string, string>>({})
  const [useDefault, setUseDefault] = useState<Record<string, boolean>>({})
  // Limits models.dev gave for a model, saved together with the window.
  const [found, setFound] = useState<Record<string, ModelsDevMatch>>({})
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'done' | 'failed'>(
    'idle'
  )

  useEffect(() => {
    setValues({})
    setUseDefault({})
    setFound({})
    setLookup('idle')
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
      const hit = found[key]
      // models.dev's reply cap and source go with its window only while the
      // user has not typed a different window over it.
      const fromDev = hit && hit.contextWindow === n
      if (n != null)
        saveMaxContextTokens(
          m,
          n,
          fromDev
            ? {
                ...(hit.maxOutputTokens != null
                  ? { maxOutputTokens: hit.maxOutputTokens }
                  : {}),
                limitsSource: 'models.dev',
              }
            : undefined
        )
      else accepted.push(m)
    }
    rememberAcceptedWindows(accepted)
    answer(true)
  }

  // One GET of the public model list; nothing about the room or its models is
  // sent. Fills a window for each model it knows and leaves the others alone.
  const lookUp = async () => {
    setLookup('loading')
    try {
      const hits = await Promise.all(
        models.map(async (m) => [
          modelKey(m),
          await lookupModelsDev(m.provider, m.id),
        ] as const)
      )
      const next: Record<string, ModelsDevMatch> = {}
      const filled: Record<string, string> = {}
      for (const [key, hit] of hits) {
        if (hit?.contextWindow == null) continue
        next[key] = hit
        filled[key] = String(hit.contextWindow)
      }
      setFound(next)
      setValues((prev) => ({ ...prev, ...filled }))
      setUseDefault((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([k]) => !(k in filled)))
      )
      setLookup('done')
    } catch {
      setLookup('failed')
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('rooms:unknownWindow.title')}</DialogTitle>
          <DialogDescription>
            {t('rooms:unknownWindow.description', {
              subject: request.subject,
              window: windowText,
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
                      window: windowText,
                    })}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex flex-col gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={lookup === 'loading'}
            onClick={lookUp}
          >
            {lookup === 'loading' && (
              <LoaderCircle className="motion-safe:animate-spin" aria-hidden />
            )}
            {lookup === 'loading'
              ? t('rooms:unknownWindow.lookingUp')
              : t('rooms:unknownWindow.lookUp')}
          </Button>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {lookup === 'done'
              ? t('rooms:unknownWindow.lookupDone', {
                  found: Object.keys(found).length,
                  total: models.length,
                })
              : lookup === 'failed'
                ? t('rooms:unknownWindow.lookupFailed')
                : t('rooms:unknownWindow.lookupHelp')}
          </p>
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
