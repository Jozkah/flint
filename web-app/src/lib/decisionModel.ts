/**
 * A decision model answers typed questions with calibrated probabilities (the
 * System One API: `POST /systemone`) and does not chat. Chat pickers leave
 * these out; the Jev decision-model picker offers them. Kept free of imports so
 * any picker can use it without a cycle.
 */
export const isDecisionModel = (model: {
  capabilities?: readonly string[]
}): boolean => !!model.capabilities?.includes('decision')

/** Decision-only: tagged for decisions and not for chat. */
export const isDecisionOnlyModel = (model: {
  capabilities?: readonly string[]
}): boolean => isDecisionModel(model) && !model.capabilities?.includes('completion')
