import { describe, expect, it, vi } from 'vitest'
import { waitForEngineReady } from '../engineReadiness'

const provider = { provider: 'llamacpp', models: [] } as unknown as ProviderObject
const hub = (reloadModel: (...args: unknown[]) => Promise<unknown>) =>
  ({ models: () => ({ reloadModel }) }) as never

describe('waitForEngineReady', () => {
  it('is ready once the model is loaded again', async () => {
    const reloadModel = vi.fn().mockResolvedValue(undefined)
    await expect(
      waitForEngineReady({ provider, modelId: 'm', serviceHub: hub(reloadModel) })
    ).resolves.toEqual({ ok: true })
    expect(reloadModel).toHaveBeenCalledWith(provider, 'm')
  })

  it('reports a failed reload, a timeout, a stop and a missing provider', async () => {
    await expect(
      waitForEngineReady({
        provider,
        modelId: 'm',
        serviceHub: hub(() => Promise.reject(new Error('no memory'))),
      })
    ).resolves.toEqual({ ok: false, reason: 'reload_failed', error: 'no memory' })

    const never = () => new Promise(() => {})
    await expect(
      waitForEngineReady({ provider, modelId: 'm', serviceHub: hub(never), timeoutMs: 5 })
    ).resolves.toEqual({ ok: false, reason: 'timeout' })

    const controller = new AbortController()
    const waiting = waitForEngineReady({
      provider,
      modelId: 'm',
      serviceHub: hub(never),
      signal: controller.signal,
    })
    controller.abort()
    await expect(waiting).resolves.toEqual({ ok: false, reason: 'aborted' })

    await expect(
      waitForEngineReady({ provider: undefined, modelId: 'm', serviceHub: hub(never) })
    ).resolves.toEqual({ ok: false, reason: 'no_provider' })
  })
})
