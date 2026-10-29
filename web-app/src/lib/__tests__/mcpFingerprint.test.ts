import { describe, expect, it, vi } from 'vitest'
import { fingerprintFor } from '../mcpFingerprint'

describe('fingerprintFor', () => {
  it('keeps the fingerprint the approval was shown without fetching', async () => {
    const serverFingerprints = vi.fn()
    expect(await fingerprintFor({ serverFingerprints }, 's', 'shown')).toBe('shown')
    expect(serverFingerprints).not.toHaveBeenCalled()
  })

  it('fetches the current fingerprint when none was shown', async () => {
    const serverFingerprints = vi.fn().mockResolvedValue({ s: 'now' })
    expect(await fingerprintFor({ serverFingerprints }, 's')).toBe('now')
  })

  it('is undefined for an unknown server or a failed lookup', async () => {
    expect(
      await fingerprintFor({ serverFingerprints: vi.fn().mockResolvedValue({}) }, 's')
    ).toBeUndefined()
    expect(
      await fingerprintFor(
        { serverFingerprints: vi.fn().mockRejectedValue(new Error('x')) },
        's'
      )
    ).toBeUndefined()
  })
})
