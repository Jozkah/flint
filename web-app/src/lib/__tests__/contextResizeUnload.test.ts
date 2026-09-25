import { describe, it, expect, vi } from 'vitest'
import { unloadForContextResize } from '../contextResizeUnload'

describe('unloadForContextResize', () => {
  it('unloads the model', async () => {
    const stopModel = vi.fn().mockResolvedValue(undefined)
    await unloadForContextResize(stopModel, 'm')
    expect(stopModel).toHaveBeenCalledWith('m')
  })

  it('does not throw when the engine rejects the unload (#123)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stopModel = vi
      .fn()
      .mockRejectedValue(new Error('No active MLX session found for model: m'))
    await expect(unloadForContextResize(stopModel, 'm')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
