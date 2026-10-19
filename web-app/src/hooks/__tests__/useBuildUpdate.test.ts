import { describe, it, expect } from 'vitest'
import { newerBuildDescription } from '../useBuildUpdate'

describe('newerBuildDescription', () => {
  it('only calls a nightly a nightly', () => {
    expect(newerBuildDescription('1.0.1-nightly.20261019')).toMatch(/nightly/i)
    expect(newerBuildDescription('1.0.0')).not.toMatch(/nightly/i)
    expect(newerBuildDescription('1.0.0')).toMatch(/newer build/i)
  })
})
