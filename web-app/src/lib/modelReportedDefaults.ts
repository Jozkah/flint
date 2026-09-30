/**
 * The sampling values a running model says it would use if nobody set any,
 * keyed by Flint's parameter names.
 *
 * llama.cpp's `/props` lists them under `default_generation_settings.params`,
 * which reflects the server's own flags and whatever sampling the model file
 * recommends. Most names match Flint's; the output cap is `n_predict`. A server
 * that reports nothing, or a remote provider, gives an empty answer and the UI
 * shows nothing rather than a guess.
 */
const SAME_NAME = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'typical_p',
  'top_n_sigma',
  'repeat_penalty',
  'repeat_last_n',
  'presence_penalty',
  'frequency_penalty',
  'mirostat',
  'mirostat_tau',
  'mirostat_eta',
  'dynatemp_range',
  'dynatemp_exp',
  'xtc_probability',
  'xtc_threshold',
  'dry_multiplier',
  'dry_base',
  'dry_allowed_length',
  'dry_penalty_last_n',
  'ignore_eos',
  'samplers',
] as const

export function reportedDefaults(
  params: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const key of SAME_NAME) {
    const v = params[key]
    if (v !== undefined && v !== null) out[key] = v
  }
  // -1 is "until the context is full", which is no cap worth showing.
  const cap = params.n_predict
  if (typeof cap === 'number' && cap > 0) out.max_output_tokens = cap
  return out
}

/** A reported value as short text: 0.8, 40, off, top_k, top_p. */
export function formatReported(value: unknown): string {
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}
