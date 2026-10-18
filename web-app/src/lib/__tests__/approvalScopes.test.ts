import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}))
// The real one talks to the backend while it starts, which these tests drive.
vi.mock('@/i18n/react-i18next-compat', () => ({
  i18n: {
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  },
}))

import {
  EVERYWHERE_CHOICE,
  addScopedRule,
  approvalScopeOptions,
  buildScopeChoice,
  checkScopedRule,
  choiceIdOf,
  describeScope,
  isAbsolutePath,
  scopeFromChoiceId,
  type ApprovalScopeWire,
} from '../approvalScopes'

const FOLDER_DEEP: ApprovalScopeWire = {
  type: 'folder',
  dir: 'C:/proj/src/components',
}
const FOLDER_ROOT: ApprovalScopeWire = { type: 'folder', dir: 'C:/proj' }
const PREFIX_ONE: ApprovalScopeWire = { type: 'command_prefix', prefix: 'cargo test' }
const PREFIX_TWO: ApprovalScopeWire = {
  type: 'command_prefix',
  prefix: 'cargo test --lib',
}

describe('the scope form', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('has no choice when the backend offered nothing standing', () => {
    expect(buildScopeChoice([], 'write')).toBeUndefined()
    expect(
      buildScopeChoice([{ type: 'once' }, { type: 'run' }], 'write')
    ).toBeUndefined()
  })

  it('selects the narrowest folder by default, not the project', () => {
    const choice = buildScopeChoice([FOLDER_ROOT, FOLDER_DEEP], 'write')!
    expect(choice.defaultId).toBe(choiceIdOf(FOLDER_DEEP))
  })

  it('selects the longest command prefix by default', () => {
    const choice = buildScopeChoice([PREFIX_ONE, PREFIX_TWO], 'bash')!
    expect(choice.defaultId).toBe(choiceIdOf(PREFIX_TWO))
  })

  it('keeps the whole-tool meaning as an explicit last option, never the default', () => {
    const choice = buildScopeChoice([FOLDER_DEEP], 'write')!
    const ids = choice.options.map((o) => o.id)
    expect(ids[ids.length - 1]).toBe(EVERYWHERE_CHOICE)
    expect(choice.defaultId).not.toBe(EVERYWHERE_CHOICE)
  })

  it('turns an option id back into the scope the backend offered, and nothing else', () => {
    const offered = [FOLDER_DEEP, PREFIX_ONE]
    expect(scopeFromChoiceId(choiceIdOf(FOLDER_DEEP)!, offered)).toEqual(FOLDER_DEEP)
    expect(scopeFromChoiceId(choiceIdOf(PREFIX_ONE)!, offered)).toEqual(PREFIX_ONE)
    // A folder or prefix that was never offered cannot be conjured from an id.
    expect(scopeFromChoiceId('folder:C:/', offered)).toBeNull()
    expect(scopeFromChoiceId('prefix:rm', offered)).toBeNull()
    expect(scopeFromChoiceId(EVERYWHERE_CHOICE, offered)).toBeNull()
    expect(scopeFromChoiceId(undefined, offered)).toBeNull()
  })

  it('only treats absolute paths as a place to ask about', () => {
    expect(isAbsolutePath('C:\\code\\app')).toBe(true)
    expect(isAbsolutePath('C:/code/app')).toBe(true)
    expect(isAbsolutePath('/home/me/app')).toBe(true)
    expect(isAbsolutePath('my project')).toBe(false)
    expect(isAbsolutePath('relative/dir')).toBe(false)
    expect(isAbsolutePath(undefined)).toBe(false)
  })

  it('describes each scope in words', () => {
    expect(describeScope(FOLDER_DEEP)).toEqual({
      key: 'permissions:rules.folder',
      values: { dir: 'C:/proj/src/components' },
    })
    expect(describeScope(PREFIX_ONE).key).toBe('permissions:rules.prefix')
    expect(describeScope({ type: 'run' }).key).toBe('permissions:rules.run')
    expect(describeScope({ type: 'once' }).key).toBe('permissions:rules.once')
  })
})

describe('asking the backend', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('passes the call as an object and never throws when the backend is gone', async () => {
    invokeMock.mockRejectedValue(new Error('no backend'))
    await expect(approvalScopeOptions('C:/p', 'write', { path: 'a' })).resolves.toEqual([])
    await expect(checkScopedRule('C:/p', 'write', { path: 'a' })).resolves.toBeNull()
  })

  it('sends non-object input as no arguments rather than guessing', async () => {
    invokeMock.mockResolvedValue([])
    await approvalScopeOptions('C:/p', 'bash', 'ls -la')
    expect(invokeMock).toHaveBeenCalledWith('agent_approval_scope_options', {
      root: 'C:/p',
      tool: 'bash',
      args: {},
    })
  })

  it('lets a refusal from the backend reach the caller when saving a rule', async () => {
    invokeMock.mockRejectedValue('this call is not inside C:/other')
    await expect(
      addScopedRule('C:/p', 'write', { path: 'a' }, { type: 'folder', dir: 'C:/other' })
    ).rejects.toBeDefined()
  })
})
