import { useAssistant } from '@/hooks/useAssistant'
import { resolveAutoCompact } from '@/lib/compaction'
import { usableContextValue } from '@/lib/modelCapabilities'

/**
 * The compaction settings a room runs under, from the same model parameters
 * Chat and Cowork read: Auto Compact (on unless switched off) and Max Context
 * Tokens (the user's window, which wins over the model's reported one).
 */
export function roomCompactionSettings(): {
  enabled: boolean
  window: number | null
} {
  const params = useAssistant.getState().currentAssistant?.parameters
  return {
    enabled: resolveAutoCompact(params, true),
    window: usableContextValue(params?.max_context_tokens) ?? null,
  }
}
