import { useEffect, useState } from 'react'
import { getLocalPropsExtension } from '@/lib/llamacppRouterProps'
import { reportedDefaults } from '@/lib/modelReportedDefaults'
import { fetchRemoteSamplingDefaults } from '@/lib/remoteSamplingDefaults'
import { useModelProvider } from '@/hooks/useModelProvider'

/**
 * What the model in use reports as its own sampling defaults: a local model
 * through its runtime, a self-hosted server on the user's network through its
 * render endpoint. Empty for a hosted provider, and before the model is up; the
 * UI then simply shows nothing.
 */
export function useModelReportedDefaults(
  providerId?: string,
  modelId?: string
): Record<string, unknown> {
  const [reported, setReported] = useState<Record<string, unknown>>({})

  useEffect(() => {
    setReported({})
    if (!providerId || !modelId) return
    let current = true
    const extension = getLocalPropsExtension(providerId)
    if (!extension?.getModelProps) {
      const provider = useModelProvider.getState().getProviderByName(providerId)
      void fetchRemoteSamplingDefaults(provider, modelId).then((values) => {
        if (current) setReported(values)
      })
      return () => {
        current = false
      }
    }
    extension
      .getModelProps(modelId)
      .then((props) => {
        if (current && props)
          setReported(reportedDefaults(props.generationDefaults))
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [providerId, modelId])

  return reported
}
