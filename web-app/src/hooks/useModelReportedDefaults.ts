import { useEffect, useState } from 'react'
import { getLocalPropsExtension } from '@/lib/llamacppRouterProps'
import { reportedDefaults } from '@/lib/modelReportedDefaults'

/**
 * What the model in use reports as its own sampling defaults, when it runs
 * locally and is loaded. Empty for a remote provider, which has no runtime to
 * ask, and before the model is up; the UI then simply shows nothing.
 */
export function useModelReportedDefaults(
  providerId?: string,
  modelId?: string
): Record<string, unknown> {
  const [reported, setReported] = useState<Record<string, unknown>>({})

  useEffect(() => {
    setReported({})
    if (!providerId || !modelId) return
    const extension = getLocalPropsExtension(providerId)
    if (!extension?.getModelProps) return
    let current = true
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
