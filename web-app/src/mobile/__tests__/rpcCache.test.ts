import { describe, expect, it } from 'vitest'
import { CACHE_LIMIT, clearRpcCache, peekRpc, primeRpc } from '../state/rpc'

describe('rpc cache', () => {
  it('drops the oldest idle reads past the limit', () => {
    clearRpcCache()
    for (let i = 0; i < CACHE_LIMIT + 10; i++) {
      primeRpc('campaigns.get' as never, { id: String(i) } as never, { n: i } as never)
    }
    expect(peekRpc('campaigns.get' as never, { id: '0' } as never)).toBeUndefined()
    expect(peekRpc('campaigns.get' as never, { id: String(CACHE_LIMIT + 9) } as never)).toEqual({
      n: CACHE_LIMIT + 9,
    })
    clearRpcCache()
  })
})
