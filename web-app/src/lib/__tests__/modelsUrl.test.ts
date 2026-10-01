import { describe, expect, it } from 'vitest'
import { modelsUrlCandidates } from '@/lib/modelsUrl'

describe('modelsUrlCandidates', () => {
  it('offers /v1 after a bare host address', () => {
    expect(modelsUrlCandidates('http://host:8000')).toEqual([
      'http://host:8000/models',
      'http://host:8000/v1/models',
    ])
  })

  it('does not add /v1 when the address already has a version segment', () => {
    expect(modelsUrlCandidates('https://api.openai.com/v1')).toEqual([
      'https://api.openai.com/v1/models',
    ])
    expect(modelsUrlCandidates('https://x.test/openai/v2/')).toEqual([
      'https://x.test/openai/v2/models',
    ])
  })

  it('trims pasted spaces and trailing slashes', () => {
    expect(modelsUrlCandidates('  http://host:8000/  ')[0]).toBe(
      'http://host:8000/models'
    )
  })

  it('keeps a path that is not a version, and tolerates a bad address', () => {
    expect(modelsUrlCandidates('http://host/api')).toEqual([
      'http://host/api/models',
      'http://host/api/v1/models',
    ])
    expect(modelsUrlCandidates('not a url')).toEqual(['not a url/models'])
  })
})
