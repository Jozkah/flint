import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(
  resolve(__dirname, '../../../../src-tauri/src/core/browser_agent/agent.js'),
  'utf8'
).trim()
const KEY = '__flint_snapshot_text_test'

type R = Record<string, unknown> & { ok: boolean; snapshot?: string }
const run = (op: string, args: Record<string, unknown> = {}): R =>
  (0, eval)(`${SRC}(${JSON.stringify(KEY)},${JSON.stringify(op)},${JSON.stringify(args)})`) as R

const page = (html: string) => {
  document.body.innerHTML = html
  delete (window as unknown as Record<string, unknown>)[KEY]
}

describe('snapshot text', () => {
  it('skips separators and punctuation-only text, keeps real text', () => {
    page(`
      <nav><a href="/a">Home</a> <span>|</span> <a href="/b">Docs</a> <span> | </span></nav>
      <p>-</p><p>•</p><p>· ·</p><p>***</p><p>/</p><p>...</p><div>—</div>
      <p>Real sentence.</p>
      <p>C++</p>
      <p>100%</p>
      <p>?</p>
    `)
    const lines = (run('snapshot').snapshot as string).split('\n')
    const texts = lines.filter((l) => l.includes('text "'))
    expect(texts.map((l) => l.trim())).toEqual([
      '- text "Real sentence."',
      '- text "C++"',
      '- text "100%"',
    ])
    expect(lines.join('\n')).not.toMatch(/text "\s*\|\s*"/)
    // Controls are still listed.
    expect(lines.join('\n')).toContain('link "Home"')
    expect(lines.join('\n')).toContain('link "Docs"')
  })

  it('keeps non-Latin text and numbers', () => {
    page('<p>日本語</p><p>42</p><p>é</p>')
    const t = run('snapshot').snapshot as string
    expect(t).toContain('text "日本語"')
    expect(t).toContain('text "42"')
    expect(t).toContain('text "é"')
  })
})

describe('dry run describes its target (for the approval prompt)', () => {
  it('returns the control label for click, type, select and a keyed press', () => {
    page(`
      <button id="b" type="button">Add to cart</button>
      <input aria-label="Search">
      <select aria-label="Size"><option>S</option><option>L</option></select>
    `)
    const snap = run('snapshot').snapshot as string
    const id = (needle: string) => /\[(\d+\.\d+)\]/.exec(snap.split('\n').find((l) => l.includes(needle))!)![1]
    expect(run('click', { id: id('button "Add to cart"'), dry: true })).toMatchObject({ ok: true, dry: true, label: 'Add to cart' })
    expect(run('type', { id: id('textbox "Search"'), text: 'x', dry: true })).toMatchObject({ label: 'Search' })
    expect(run('select', { id: id('combobox "Size"'), value: 'L', dry: true })).toMatchObject({ label: 'Size' })
    expect(run('press', { key: 'Escape', id: id('textbox "Search"'), dry: true })).toMatchObject({ label: 'Search' })
    // A press with no target names nothing.
    expect(run('press', { key: 'Escape', dry: true })).toMatchObject({ ok: true, label: '' })
  })

  it('a stale node id fails the dry run, which is what stops it before the prompt', () => {
    page('<button type="button">A</button>')
    run('snapshot')
    expect(run('click', { id: '9.9', dry: true })).toMatchObject({ ok: false, code: 'stale' })
    expect(run('type', { id: '1.99', text: 'x', dry: true })).toMatchObject({ ok: false, code: 'stale' })
  })
})
