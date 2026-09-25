import type { GenerationSample } from '@/stores/engine-activity-store'

/** Providers whose models run inside Flint's own engine on this machine. */
export const isEngineProviderName = (provider: string) =>
  provider === 'llamacpp' || provider === 'mlx'

/** The last path segment, on either separator. */
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** A model's configured context length, when it has one. */
export function contextLengthOf(model: Model): number | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value = (model.settings as any)?.ctx_len?.controller_props?.value
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** The quantization named in a GGUF model id, e.g. `Q4_K_M`, when there is one. */
export function quantOf(id: string): string | undefined {
  const m = /(?:^|[-_.])((?:IQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?:$|[-_.])/i.exec(id)
  return m ? m[1].toUpperCase() : undefined
}

export const formatTps =(v: number) => `${v.toFixed(1)} tok/s`

/** Mean speed per model over the recorded replies. */
export function averageSpeeds(
  samples: GenerationSample[]
): Map<string, { avg: number; count: number }> {
  const sums = new Map<string, { total: number; count: number }>()
  for (const s of samples) {
    const cur = sums.get(s.model) ?? { total: 0, count: 0 }
    cur.total += s.tps
    cur.count += 1
    sums.set(s.model, cur)
  }
  const out = new Map<string, { avg: number; count: number }>()
  for (const [model, { total, count }] of sums) {
    out.set(model, { avg: total / count, count })
  }
  return out
}

/** The most recent `n` speeds, oldest first, optionally for one model. */
export function recentSpeeds(
  samples: GenerationSample[],
  n: number,
  model?: string
): number[] {
  const list = model ? samples.filter((s) => s.model === model) : samples
  return list.slice(-n).map((s) => s.tps)
}
