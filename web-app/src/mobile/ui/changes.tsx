// A Cowork session's changes, as the desktop shows them: the bars above the
// composer (files ready for review, the worktree's branch, the pull request),
// the one-line What changed after a run, the Changes list with its diffs, and
// the Activity list. Read-only: applying and merging happen on the computer.
import { useState } from 'react'
import type { ChangedFile, CoworkActivity, CoworkChanges } from '@/lib/remote/protocol'
import { Empty } from './bits'
import { I } from './icons'
import { openDrawer, openSheet, toast } from '../state/app'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function totals(files: ChangedFile[]) {
  return {
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  }
}

/** One write's diff (`+ ` / `- ` lines, as Cowork records them). */
export function Diff({ text }: { text: string }) {
  const lines = text.split('\n').filter((l, i, all) => l || i < all.length - 1)
  return (
    <div className="diff hunk">
      {lines.map((l, i) => {
        const sign = l.startsWith('+') ? '+' : l.startsWith('-') ? '−' : ''
        const body = sign ? l.slice(l[1] === ' ' ? 2 : 1) : l.replace(/^ {2}/, '')
        return (
          <div key={i} className={sign === '+' ? 'a' : sign ? 'r' : undefined}>
            <span className="ln" />
            <span className="sg">{sign}</span>
            <span>{body}</span>
          </div>
        )
      })}
    </div>
  )
}

/** The bars above the composer. */
export function ChangeBars({ c }: { c: CoworkChanges }) {
  const [more, setMore] = useState(false)
  const t = totals(c.files)
  const pr = c.pr
  const extra = pr && (pr.conflicts || pr.checks.failed > 0)
  return (
    <div className="bars" data-testid="change-bars">
      {c.files.length > 0 && (
        <div className="frame bar1">
          <I n="file" />
          <b>{plural(c.files.length, 'file')} ready for review</b>
          <span className="add">+{t.additions}</span>
          <span className="del">−{t.deletions}</span>
          <span className="sp" />
          <button type="button" className="btn sm" onClick={() => openDrawer('right', 'changes')}>
            Review changes
          </button>
        </div>
      )}
      {c.worktree && (
        <div className="frame bar1" style={{ flexWrap: 'wrap' }}>
          <I n="branch" />
          <b className="mono" style={{ fontSize: 12 }}>
            {c.worktree.branch ?? 'Working copy'}
          </b>
          <span className="sp" />
          <button type="button" className="btn sm ghost" aria-label="Worktree" onClick={() => openSheet('worktree', { path: c.worktree?.path, branch: c.worktree?.branch })}>
            <I n="more" />
          </button>
        </div>
      )}
      {pr && extra && !more && (
        <button type="button" className="morebars" onClick={() => setMore(true)}>
          Show 1 more · {pr.conflicts ? 'Conflicts' : 'CI'}
        </button>
      )}
      {pr && (!extra || more) && (
        <div className={`frame bar1 prbar${pr.conflicts ? ' conflict' : ''}`}>
          <I n="pr" />
          <b>#{pr.number}</b>
          <span className="muted" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pr.title}
          </span>
          <span className="sp" />
          {pr.conflicts && (
            <button type="button" className="chip err" onClick={() => toast('Resolve the conflicts from the computer')}>
              <span className="d" />
              Conflicts
            </button>
          )}
          <span className={`chip ${pr.checks.failed ? 'err' : pr.checks.pending ? 'warn' : 'ok'}`}>
            <span className="d" />
            CI {pr.checks.failed ? `${pr.checks.failed} failed` : pr.checks.pending ? 'running' : 'passed'}
          </span>
        </div>
      )}
    </div>
  )
}

/** "What changed", one quiet line after a run, opening to the files. */
export function WhatChanged({ c }: { c: CoworkChanges }) {
  if (!c.summary) return null
  return (
    <details className="wcline" data-testid="what-changed">
      <summary>
        <b title="Recorded by Flint, not written by the model.">What changed</b>
        <span className="muted">{c.summary}</span>
        <I n="chev" size={13} style={{ marginLeft: 'auto', color: 'var(--subtle-foreground)' }} />
      </summary>
      <div className="frame wc" style={{ margin: '8px 0 0' }}>
        <div className="sec" style={{ borderTop: 0 }}>
          <span className="lbl">Where the result is</span>
          {c.worktree ? 'In a separate worktree Flint manages, not in your checkout.' : c.applyOnDesktop ? 'In a review copy; apply it to the folder on the computer.' : 'In the folder.'}
          {c.files.map((f) => (
            <div key={f.path} className="fl">
              <span>{f.path}</span>
              <span>
                <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </details>
  )
}

export function ChangesList({ c }: { c: CoworkChanges }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!c.files.length) return <Empty>No changes yet.</Empty>
  return (
    <>
      <div className="lbl">
        Cowork output · {c.worktree ? 'Session worktree' : c.applyOnDesktop ? 'Review copy' : 'Folder'}
      </div>
      <div className="card2" style={{ padding: 0, overflow: 'hidden' }} data-testid="changes-list">
        {c.files.map((f) => (
          <div key={f.path}>
            <button
              type="button"
              className="kv"
              style={{ all: 'unset', display: 'flex', width: '100%', boxSizing: 'border-box', padding: '10px 12px', gap: 8, alignItems: 'center', borderTop: '.8px dashed var(--border)', cursor: 'pointer' }}
              onClick={() => setOpen((o) => (o === f.path ? null : f.path))}
              aria-expanded={open === f.path}
            >
              <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                {f.path}
              </span>
              <span className="add">+{f.additions}</span>
              <span className="del">−{f.deletions}</span>
            </button>
            {open === f.path && (
              <div style={{ padding: '0 12px 10px' }}>
                <small className="muted">By {f.source}</small>
                {f.hunks.map((h, i) => (
                  <Diff key={i} text={h} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {c.applyOnDesktop && (
        <p className="sh" style={{ margin: '8px 0 0' }}>
          Applying these to the folder is done on the computer, where you can see each file first.
        </p>
      )}
    </>
  )
}

const STATUS: Record<string, [string, string]> = {
  running: ['warn live', 'Running'],
  queued: ['', 'Queued'],
  done: ['ok', 'Finished'],
  failed: ['err', 'Failed'],
  awaiting: ['warn', 'Waiting for approval'],
}

export function ActivityList({ a }: { a: CoworkActivity }) {
  const rows = [
    ...a.subagents.map((s) => ({ id: s.id, kind: 'Agent', title: s.name, sub: `${plural(s.steps, 'tool call')}`, status: s.status as string })),
    ...a.commands.map((c) => ({ id: c.id, kind: 'Command', title: c.command, sub: '', status: c.status as string })),
  ]
  if (!rows.length) return <Empty>No subagents or commands in this session yet.</Empty>
  const running = rows.filter((r) => r.status === 'running' || r.status === 'queued' || r.status === 'awaiting')
  const finished = rows.filter((r) => !running.includes(r))
  const row = (r: (typeof rows)[number]) => {
    const [cls, word] = STATUS[r.status] ?? ['', r.status]
    return (
      <div key={r.id} className="card2" style={{ flexDirection: 'row', alignItems: 'center' }}>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <b className={r.kind === 'Command' ? 'mono' : undefined} style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.title}
          </b>
          <small className="muted">
            {r.kind}
            {r.sub ? ` · ${r.sub}` : ''}
          </small>
        </span>
        <span className={`chip ${cls}`}>
          <span className="d" />
          {word}
        </span>
      </div>
    )
  }
  return (
    <div data-testid="activity-list">
      {running.length > 0 && <div className="lbl">Running ({running.length})</div>}
      {running.map(row)}
      {finished.length > 0 && <div className="lbl">Finished ({finished.length})</div>}
      {finished.map(row)}
    </div>
  )
}
