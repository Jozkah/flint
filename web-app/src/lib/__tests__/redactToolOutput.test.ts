/**
 * Tool output is redacted before it is persisted. AH-045.
 *
 * The assertions that matter are the ones about what must NOT come back: the
 * original credential, and the original text on the failure path. A test that
 * only checks the happy path passes against a redactor that quietly falls back
 * to storing the input.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const secretsRedact = vi.fn()
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  secretsRedact: (...a: unknown[]) => secretsRedact(...a),
}))

import { redactDeep, redactText, UNREDACTABLE } from '../redactToolOutput'

const KEY = 'sk-live-abcdefghijklmnopqrstuvwxyz012345'

beforeEach(() => {
  secretsRedact.mockReset()
  // Stand-in for the Rust rules: the point here is the wiring, not the matching.
  secretsRedact.mockImplementation(async (text: string) =>
    text.split(KEY).join('sk-[redacted]')
  )
})

describe('redacting text', () => {
  it('sends the text to the backend rather than matching it here', async () => {
    await redactText('Authenticated with ' + KEY)
    expect(secretsRedact).toHaveBeenCalledWith('Authenticated with ' + KEY)
  })

  it('returns text with the credential gone', async () => {
    const out = await redactText('Authenticated with ' + KEY)
    expect(out).not.toContain(KEY)
    expect(out).toContain('Authenticated with')
  })

  /// The path a fallback would ruin. Returning the input on failure would
  /// persist exactly what this exists to remove, on the one branch nobody
  /// exercises by hand.
  it('withholds the text when redaction fails, rather than storing it raw', async () => {
    secretsRedact.mockRejectedValue(new Error('plugin unavailable'))
    const out = await redactText('Authenticated with ' + KEY)
    expect(out).not.toContain(KEY)
    expect(out).toBe(UNREDACTABLE)
  })

  it('leaves empty text alone without a round trip', async () => {
    expect(await redactText('')).toBe('')
    expect(secretsRedact).not.toHaveBeenCalled()
  })
})

describe('redacting a whole tool result', () => {
  it('reaches a credential nested inside content parts', async () => {
    const result = {
      content: [
        { type: 'text', text: 'ok' },
        { type: 'text', text: `Authorization: ${KEY}` },
      ],
    }
    const out = await redactDeep(result)
    expect(JSON.stringify(out)).not.toContain(KEY)
    // The shape the model expects is unchanged.
    expect(out.content).toHaveLength(2)
    expect(out.content[0]).toEqual({ type: 'text', text: 'ok' })
    expect(out.content[1].type).toBe('text')
  })

  it('makes one round trip for a result with many strings', async () => {
    await redactDeep({ a: 'one', b: ['two', 'three'], c: { d: 'four' } })
    expect(secretsRedact).toHaveBeenCalledTimes(1)
  })

  it('keeps non-string values as they are', async () => {
    const out = await redactDeep({ n: 42, b: true, z: null, s: 'text' })
    expect(out).toEqual({ n: 42, b: true, z: null, s: 'text' })
  })

  /// If the backend returns a different number of parts they cannot be matched
  /// back to their fields, and guessing would move one field's text into
  /// another's. Withhold instead.
  it('withholds everything when the parts cannot be matched back up', async () => {
    secretsRedact.mockResolvedValue('only one part came back')
    const out = await redactDeep({ a: `x ${KEY}`, b: 'y' })
    expect(JSON.stringify(out)).not.toContain(KEY)
    expect(out).toEqual({ a: UNREDACTABLE, b: UNREDACTABLE })
  })

  it('withholds everything when the backend fails', async () => {
    secretsRedact.mockRejectedValue(new Error('plugin unavailable'))
    const out = await redactDeep({ a: `x ${KEY}` })
    expect(JSON.stringify(out)).not.toContain(KEY)
  })

  it('does nothing at all to a result with no strings in it', async () => {
    const out = await redactDeep({ count: 3 })
    expect(out).toEqual({ count: 3 })
    expect(secretsRedact).not.toHaveBeenCalled()
  })
})
