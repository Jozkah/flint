import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  allVariableNames,
  configUsesPlaceholders,
  missingVariables,
  normalizeVars,
  serversUsing,
  unresolvedNote,
  unresolvedServers,
  varsFromMetadata,
  withoutUnresolved,
} from '../mcpSessionVars'
import { useMcpPlaceholders } from '@/hooks/useMcpPlaceholders'
import { ensureMcpVariables, variablesDeclinedError } from '../mcpVariablePrompt'

const placeholders = {
  idea: ['project_path'],
  obsidian: ['obsidian_port'],
  docs: ['docs_dir', 'project_path'],
}

describe('mcpSessionVars', () => {
  it('lists the variables a server leaves unset, blank counting as unset', () => {
    expect(missingVariables(placeholders, 'docs', { project_path: '/p' })).toEqual([
      'docs_dir',
    ])
    expect(missingVariables(placeholders, 'idea', { project_path: '  ' })).toEqual([
      'project_path',
    ])
    expect(missingVariables(placeholders, 'plain', {})).toEqual([])
    expect(missingVariables(placeholders, undefined, {})).toEqual([])
  })

  it('finds the templates a session leaves unresolved', () => {
    expect([...unresolvedServers(placeholders, { project_path: '/p' })].sort()).toEqual([
      'docs',
      'obsidian',
    ])
    expect(
      unresolvedServers(placeholders, {
        project_path: '/p',
        obsidian_port: '27124',
        docs_dir: '/d',
      }).size
    ).toBe(0)
  })

  it('names every variable once, and the servers using each', () => {
    expect(allVariableNames(placeholders)).toEqual([
      'docs_dir',
      'obsidian_port',
      'project_path',
    ])
    expect(serversUsing(placeholders, 'project_path')).toEqual(['docs', 'idea'])
  })

  it('withholds only the tools of unresolved templates', () => {
    const tools = [
      { name: 'a', server: 'idea' },
      { name: 'b', server: 'fs' },
      { name: 'c' },
    ]
    expect(withoutUnresolved(tools, new Set(['idea'])).map((t) => t.name)).toEqual([
      'b',
      'c',
    ])
  })

  it('cleans values for storage', () => {
    expect(normalizeVars({ ok: '1', 'bad name': 'x', blank: ' ', ' trimmed ': 'v' })).toEqual({
      ok: '1',
      trimmed: 'v',
    })
    expect(normalizeVars({ blank: '' })).toBeUndefined()
    expect(varsFromMetadata({ mcpVariables: { a: '1', b: 2 } })).toEqual({ a: '1' })
    expect(varsFromMetadata({ mcpVariables: ['x'] })).toBeUndefined()
    expect(varsFromMetadata(undefined)).toBeUndefined()
  })

  it('recognises a template config by its placeholders', () => {
    expect(configUsesPlaceholders({ url: 'http://127.0.0.1:{{ port }}/mcp' })).toBe(true)
    expect(configUsesPlaceholders({ headers: { P: '{{project_path}}' } })).toBe(true)
    expect(configUsesPlaceholders({ args: ['-y', '{{docs_dir}}'] })).toBe(true)
    expect(configUsesPlaceholders({ args: ['${HOME}', '{"a":1}'], env: { A: 'b' } })).toBe(false)
  })

  it('tells the model which servers were withheld and why', () => {
    const note = unresolvedNote(['obsidian'], placeholders, {})
    expect(note).toContain('obsidian ({{obsidian_port}})')
    expect(unresolvedNote([], placeholders, {})).toBeNull()
  })
})

describe('ensureMcpVariables', () => {
  beforeEach(() => {
    useMcpPlaceholders.setState({ placeholders })
  })

  it('returns the values as they are when nothing is missing', async () => {
    const ask = vi.fn()
    const save = vi.fn()
    const vars = { project_path: '/p' }
    expect(await ensureMcpVariables('idea', vars, save, ask)).toBe(vars)
    expect(await ensureMcpVariables('plain', undefined, save, ask)).toBeUndefined()
    expect(ask).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('asks for the missing values, saves them merged and returns them', async () => {
    const ask = vi.fn().mockResolvedValue({ docs_dir: '/d' })
    const save = vi.fn()
    const out = await ensureMcpVariables('docs', { project_path: '/p' }, save, ask)
    expect(ask).toHaveBeenCalledWith('docs', ['docs_dir'])
    expect(out).toEqual({ project_path: '/p', docs_dir: '/d' })
    expect(save).toHaveBeenCalledWith({ project_path: '/p', docs_dir: '/d' })
  })

  it('returns null and saves nothing when the user cancels or leaves one out', async () => {
    const save = vi.fn()
    expect(
      await ensureMcpVariables('idea', {}, save, vi.fn().mockResolvedValue(null))
    ).toBeNull()
    expect(
      await ensureMcpVariables('docs', {}, save, vi.fn().mockResolvedValue({ docs_dir: '/d' }))
    ).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('words the refusal the model sees', () => {
    expect(variablesDeclinedError('idea', ['project_path'])).toContain(
      "'idea' needs session variables that are not set: {{project_path}}"
    )
  })
})
