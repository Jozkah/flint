/**
 * The checks that refuse a cowork run before anything is claimed: no model,
 * a model without tool calling, or a Managed-worktree session whose grant is
 * not back yet. Split out of `runCoworkRequest` (Q2-002); behaviour
 * unchanged. Each refusal says why with a toast and calls `onRefused`.
 */
import { toast } from 'sonner'
import type { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { enableModelCapabilities } from '@/lib/modelCapabilityEnable'
import type { CoworkModelChoice } from '@/lib/coworkModelChoice'
import {
  effectiveDowngradeKey,
  type accessOf,
  type effectiveAccess,
} from '@/lib/coworkAccess'

export type RefuseUnrunnableInput = {
  resolved: CoworkModelChoice<Model>
  globalProvider: ReturnType<typeof useModelProvider.getState>['selectedProvider']
  access: ReturnType<typeof accessOf>
  effective: ReturnType<typeof effectiveAccess>
  t: ReturnType<typeof useTranslation>['t']
  onRefused?: () => void
}

/** `true` when the run was refused (and the user told why). */
export function refuseUnrunnable({
  resolved,
  globalProvider,
  access,
  effective,
  t,
  onRefused,
}: RefuseUnrunnableInput): boolean {
  const selectedModel = resolved.model
  if (!selectedModel?.id) {
    toast.error(
      resolved.unavailable
        ? t('common:sessionModelUnavailable', { model: resolved.unavailable.id })
        : resolved.needsKey
          ? t('common:selectModelNoKey', { provider: resolved.needsKey })
          : t('common:selectModel')
    )
    onRefused?.()
    return true
  }
  // Without tool calling the transport drops the tool set silently, and the
  // agent then narrates work it never did. Refusing up front is honest; a
  // toolless "agent" run is worse than no run.
  if (!selectedModel.capabilities?.includes('tools')) {
    // A custom endpoint never reports capabilities, so the model can be fine
    // and still look toolless. Offer the user's own override where the
    // refusal is, the way a tool-call message offers it in chat.
    const modelId = selectedModel.id
    const providerId = resolved.choice?.provider ?? globalProvider
    // Kept until dismissed: it is the only sign the send was refused, and
    // its action is the fix (CW-002: a 4 s toast read as a silent no-op).
    toast.error(t('common:modelNoTools', { model: modelId }), {
      duration: Infinity,
      action: providerId
        ? {
            label: t('common:modelCapability.enableAlways'),
            onClick: () => {
              const store = useModelProvider.getState()
              const owner = store.getProviderByName(providerId)
              if (!owner) return
              store.updateProvider(providerId, {
                ...owner,
                models: enableModelCapabilities(owner.models, modelId, [
                  'tools',
                ]),
              })
            },
          }
        : undefined,
    })
    onRefused?.()
    return true
  }
  // A restored session may remember Managed worktree while its process-local
  // grant is still being reissued. Do not start a Review run against the
  // source folder: history would point at a worktree the run cannot read.
  if (access === 'managed-worktree' && effective.destination !== 'managed') {
    const key = effectiveDowngradeKey(effective)
    if (key) toast.error(t(key))
    onRefused?.()
    return true
  }
  return false
}
