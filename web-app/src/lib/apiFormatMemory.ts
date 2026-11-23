import { toast } from 'sonner'
import { i18n } from '@/i18n/react-i18next-compat'
import type { ApiFormat } from '@/lib/apiFormat'

const FORMAT_NAME: Record<ApiFormat, string> = {
  chat: 'Chat Completions',
  responses: 'Responses',
}

/**
 * A request failed on one API and worked on the other: keep the working one on
 * the model (shown in Edit Model as "Detected", resettable) and say so in one
 * line instead of the raw endpoint error.
 */
export function rememberApiFormat(
  providerName: string,
  modelId: string,
  format: ApiFormat,
  from: ApiFormat
): void {
  void (async () => {
    try {
      const { useModelProvider } = await import('@/hooks/useModelProvider')
      const state = useModelProvider.getState()
      const current = state.providers.find((p) => p.provider === providerName)
      if (current) {
        state.updateProvider(providerName, {
          models: current.models.map((m) =>
            m.id === modelId ? { ...m, detectedApiFormat: format } : m
          ),
        })
      }
    } catch (e) {
      console.warn('[api-format] could not remember the detected format:', e)
    }
  })()
  toast.info(
    i18n.t('providers:editModel.apiFormat.switched', {
      model: modelId,
      from: FORMAT_NAME[from],
      to: FORMAT_NAME[format],
    })
  )
}
