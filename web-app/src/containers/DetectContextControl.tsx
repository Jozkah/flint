import { useState } from 'react'
import type { ReactNode } from 'react'
import { Gauge, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getLocalPropsExtension } from '@/lib/llamacppRouterProps'
import { fetchServerWindow } from '@/lib/serverWindow'
import { detectContextWindow } from '@/lib/detectContextWindow'

interface DetectContextControlProps {
  /** The currently selected model. The button is off without both. */
  providerId?: string
  modelId?: string
  /** Fills the field. Called only with a real, detected number. */
  onDetected: (tokens: number) => void
  /** The Max Context Tokens input. */
  children: ReactNode
}

/**
 * The Max Context Tokens input with a "Detect from model" button beside it and
 * a caption underneath saying where the number came from, or that none was
 * found.
 */
export function DetectContextControl({
  providerId,
  modelId,
  onDetected,
  children,
}: DetectContextControlProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [busy, setBusy] = useState(false)
  const [caption, setCaption] = useState<{ text: string; failed: boolean } | null>(
    null
  )
  const label = t('common:detectContext.button')
  const disabled = busy || !providerId || !modelId

  const run = async () => {
    if (!providerId || !modelId) return
    setBusy(true)
    setCaption(null)
    try {
      const store = useModelProvider.getState()
      const provider = store.getProviderByName(providerId)
      const model = provider?.models.find((m) => m.id === modelId)
      const result = await detectContextWindow({
        providerId,
        modelId,
        model: model as unknown as Record<string, unknown> | undefined,
        provider: provider as unknown as Record<string, unknown> | undefined,
        getRuntimeProps: (pid, mid) =>
          getLocalPropsExtension(pid)?.getModelProps?.(mid) ?? Promise.resolve(null),
        fetchModelEntry: (mid) =>
          provider && serviceHub.providers().fetchModelEntry
            ? serviceHub.providers().fetchModelEntry!(provider, mid)
            : Promise.resolve(null),
        fetchLocalServerWindow: fetchServerWindow,
      })
      if ('tokens' in result) {
        onDetected(result.tokens)
        setCaption({
          failed: false,
          text: t('common:detectContext.found', {
            tokens: result.tokens.toLocaleString(),
            source: t(`common:detectContext.sources.${result.source}`),
          }),
        })
      } else {
        setCaption({ failed: true, text: t('common:detectContext.unknown') })
      }
    } catch {
      setCaption({ failed: true, text: t('common:detectContext.unknown') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 min-w-0">
        {children}
        <Tooltip>
          <TooltipTrigger asChild>
            {/* span keeps the tooltip alive while the button is disabled */}
            <span className="inline-flex shrink-0">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="h-8 w-8"
                aria-label={label}
                disabled={disabled}
                onClick={run}
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Gauge className="size-3.5 text-muted-foreground" aria-hidden />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {providerId && modelId ? label : t('common:detectContext.noModel')}
          </TooltipContent>
        </Tooltip>
      </div>
      {caption && (
        <p
          role="status"
          className={
            caption.failed
              ? 'text-xs text-destructive'
              : 'text-xs text-muted-foreground'
          }
        >
          {caption.text}
        </p>
      )}
    </div>
  )
}
