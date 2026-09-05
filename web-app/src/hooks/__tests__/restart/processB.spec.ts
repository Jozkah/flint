import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backendStorage', async () => {
  const { fileStorage } = await import('./persistProcess')
  return { backendStorage: fileStorage }
})

const { useClaudeCompat } = await import('@/hooks/useClaudeCompat')

const ROOT = '/home/dev/obs-forwarder'

/**
 * Process B: a fresh start against what process A left behind.
 *
 * This is the whole point. The module was never loaded in this process, so
 * nothing is in memory except what rehydration puts there — which is the same
 * position Jan is in after a restart.
 */
/**
 * Driven by `scripts/cowork-compat-smoke.sh`, which supplies the shared file.
 *
 * Skipped rather than failed when it is absent, because the default runner
 * picks this file up too and a two-process fixture cannot work in one process.
 * Skipping rather than excluding the directory is deliberate: a skipped spec
 * still names itself in the output, so the coverage it represents is visibly
 * absent instead of silently missing.
 */
const withFixture = describe.skipIf(!process.env.JAN_RESTART_FIXTURE)

withFixture('process B: starting again against the same stored state', () => {
  it('restores what grants nothing, and none of what does', async () => {
    await useClaudeCompat.persist.rehydrate()
    const store = useClaudeCompat.getState()

    // The opt-in survives: switching it on reads a folder's configuration and
    // grants nothing on its own.
    expect(store.enabledFor(ROOT)).toBe(true)
    expect(store.skillRoots).toEqual(['/home/dev/.claude/skills'])

    // Allowing a server means allowing a process. A consent silently
    // reinstated at launch would start one on a decision made long ago that
    // the user cannot see.
    expect(store.consentedMcp(ROOT)).toEqual(new Set())
    expect(store.mcpFingerprints[ROOT]).toBeUndefined()

    // And nothing is running: no server was reconnected, so no tools exist.
    expect(store.runtimeFor(ROOT)).toEqual({})
  })

  it('has no record of a live server anywhere', async () => {
    await useClaudeCompat.persist.rehydrate()

    const serialized = JSON.stringify(useClaudeCompat.getState())
    expect(serialized).not.toContain('search_docs')
    expect(serialized).not.toContain('fingerprint-for-docs')
  })
})
