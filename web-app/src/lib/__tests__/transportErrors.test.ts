import { describe, expect, it } from 'vitest'
import {
  cleanUpstreamErrorMessage,
  describeTransportError,
  isSamplingParamRejection,
} from '@/lib/model-factory'
import * as moved from '@/lib/model/transportErrors'

// Characterization of the transport/upstream error helpers, written before
// they moved out of model-factory. Both import paths must agree.
const CASES: Array<[string, string | null]> = [
  ['plain upstream 400', null],
  [
    'error sending request for url (http://10.0.0.2:8080/v1): no route to host',
    "Couldn't reach the provider — the host or network is unreachable. Check that the server is running and that any VPN or Tailscale connection to it is up.\nDetails: error sending request for url (http://10.0.0.2:8080/v1): no route to host",
  ],
  [
    'dns error: failed to lookup address information',
    "Couldn't reach the provider — the address could not be resolved. Check the provider's Base URL and your internet connection.\nDetails: dns error: failed to lookup address information",
  ],
  [
    'operation timed out',
    'The provider took too long to respond and the request timed out. It may be overloaded or slow to start — try again.\nDetails: operation timed out',
  ],
  [
    'invalid peer certificate: UnknownIssuer',
    "Couldn't establish a secure connection to the provider (TLS/certificate error). Verify the endpoint URL.\nDetails: invalid peer certificate: UnknownIssuer",
  ],
  [
    'Connection refused   (os error 10061)',
    "Couldn't reach the provider — the connection failed. Check the provider's Base URL and your internet connection, then try again.\nDetails: Connection refused (os error 10061)",
  ],
]

describe('transport error helpers', () => {
  it.each(CASES)('describes %s', (raw, want) => {
    expect(describeTransportError(new Error(raw))).toBe(want)
    expect(moved.describeTransportError(raw)).toBe(want)
  })

  it('bounds the raw detail at 300 chars', () => {
    const out = describeTransportError('failed to fetch ' + 'x'.repeat(400))!
    const detail = out.split('\nDetails: ')[1]
    expect(detail.length).toBe(301)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('treats empty and non-errors as not transport', () => {
    expect(describeTransportError('')).toBeNull()
    expect(describeTransportError(undefined)).toBeNull()
  })

  it.each([
    ['Unsupported parameter: top_k', true],
    ['temperature and top_p cannot both be specified', true],
    ["property 'seed' is unsupported", true],
    ['field `min_p` is not allowed', true],
    ['unrecognized arguments: --x', true],
    ['rate limited', false],
  ])('sampling rejection %s', (msg, want) => {
    expect(isSamplingParamRejection(msg)).toBe(want)
    expect(moved.isSamplingParamRejection(msg)).toBe(want)
  })

  it('cleans upstream messages the same way', () => {
    const raw = '------------\nWhile executing X\n  ^\nsomething broke'
    expect(cleanUpstreamErrorMessage(raw)).toBe(
      moved.cleanUpstreamErrorMessage(raw)
    )
    expect(cleanUpstreamErrorMessage('a\nError: root cause\nmore')).toBe(
      'root cause'
    )
  })
})
