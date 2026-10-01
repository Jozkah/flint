// The effort bar's stops, as ReasoningEffortSlider computes them.
import type { ChatDetails, EffortChoiceWire } from '@/lib/remote/protocol'
import { clampEffort, effortLabel, type EffortLevel } from '@/lib/modelEffort'

/** The bar's stops and the one shown, as ReasoningEffortSlider computes them. */
export function effortStops(e: NonNullable<ChatDetails['effort']>) {
  const levels = e.levels as EffortLevel[]
  const stops: EffortChoiceWire[] = e.canDisable ? ['off', ...levels] : levels
  const chosen: EffortChoiceWire | null =
    e.value === 'off' ? (e.canDisable ? 'off' : null) : e.value ? clampEffort(e.value as EffortLevel, levels) : null
  const fallback = e.recommended && levels.includes(e.recommended as EffortLevel) ? e.recommended : levels[Math.floor(levels.length / 2)]
  return { stops, shown: (chosen ?? fallback) as EffortChoiceWire }
}

export const stopLabel = (s: EffortChoiceWire) => (s === 'off' ? 'Off' : effortLabel(s as EffortLevel))
