// The right panel's newer tabs: "What Flint is using" for a chat, and the
// Cowork Code and Preview tabs, read-only views of the desktop's panels.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CoworkFileResult } from '@/lib/remote/protocol'
import { Empty, Kv, Pills } from '../ui/bits'
import { codeRefToken, compact } from '../ui/format'
import { I, type IconId } from '../ui/icons'
import { ContextCard } from '../ui/reply'
import { act, app, client, closeAll, openSheet, toast, useApp } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { insertIntoComposer } from '../state/attachments'

const SECTION_ICON: Record<string, IconId> = {
  model: 'cube',
  instructions: 'book',
  attachments: 'clip',
  memory: 'star',
  tools: 'flow',
  payload: 'clock',
}

function Card({ icon, title, right, children }: { icon: IconId; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="card2">
      <h4>
        <I n={icon} />
        {title}
        {right && <span className="muted" style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 12 }}>{right}</span>}
      </h4>
      {children}
    </div>
  )
}

const PREVIEW = 3

/** WhatJanIsUsing: the context, model, instructions, attachments, memory,
 * tools and the last request, as the desktop panel summarises them. */
export function ChatUsing({ id }: { id: string }) {
  const { data, error } = useRpc('chat.details', { id })
  const tools = useRpc('tools.list', {})
  const [tab, setTab] = useState<'using' | 'files'>('using')
  const [more, setMore] = useState<Record<string, boolean>>({})
  if (!data) return error ? <Empty>{error.message}</Empty> : <Empty>Loading…</Empty>
  const c = data.context
  const pct = c?.windowTokens ? Math.min(100, (c.usedTokens / c.windowTokens) * 100) : 0
  return (
    <>
      <Pills
        items={[
          { id: 'using', label: 'What Flint is using' },
          { id: 'files', label: `Files (${data.files.length})` },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'files' ? (
        data.files.length ? (
          <div className="card2">{data.files.map((f) => <Kv key={f.name} k={<span className="mono">{f.name}</span>} v={f.state} />)}</div>
        ) : (
          <Empty>No files in this conversation.</Empty>
        )
      ) : (
        <>
          <Card icon="gauge" title="Context" right={c ? `${compact(c.usedTokens)}${c.windowTokens ? ` of ${compact(c.windowTokens)}` : ''}` : undefined}>
            <div className="meter"><i style={{ width: `${pct}%` }} /></div>
            <small className="muted">{c?.autoCompactOn ? 'Auto-compacts before the window fills' : 'Auto-compact is off'}</small>
          </Card>
          {data.sections
            .filter((s) => s.id !== 'payload')
            .map((s) => {
              const shown = more[s.id] ? s.items : s.items.slice(0, PREVIEW)
              return (
                <Card key={s.id} icon={SECTION_ICON[s.id] ?? 'info'} title={s.title}>
                  {s.items.length === 0 && <small className="muted">{s.empty ?? 'Nothing here.'}</small>}
                  {shown.map((item, i) => (
                    <Kv key={`${item.label}-${i}`} k={<span className={s.id === 'tools' || s.id === 'attachments' ? 'mono' : undefined}>{item.label}{item.detail ? ` · ${item.detail}` : ''}</span>} v={item.state} />
                  ))}
                  {s.items.length > PREVIEW && (
                    <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setMore((m) => ({ ...m, [s.id]: !m[s.id] }))}>
                      {more[s.id] ? 'Show fewer' : `Show all (${s.items.length})`}
                    </button>
                  )}
                  {s.id === 'tools' &&
                    data.serversOff.map((name) => {
                      const server = tools.data?.servers.find((x) => x.name === name)
                      return (
                        <div key={name} className="mcpoff" data-testid="server-off">
                          <b>{name} is off</b>
                          <span>You mentioned it, but it isn&apos;t running, so its tools aren&apos;t available to this reply.</span>
                          <button type="button" className="btn sm" disabled title="Turning servers on needs the computer" onClick={() => toast(`Turn ${server?.name ?? name} on from the computer.`)}>
                            Enable on the computer
                          </button>
                        </div>
                      )
                    })}
                </Card>
              )
            })}
          {data.lastRequest && (
            <Card icon="clock" title="Last request">
              <Kv k="Tokens" v={`${(data.lastRequest.inputTokens ?? 0).toLocaleString()} in · ${(data.lastRequest.outputTokens ?? 0).toLocaleString()} out`} />
              {data.lastRequest.cachedInputTokens !== undefined && <Kv k="Prompt cache" v={data.lastRequest.cachedInputTokens > 0 ? 'Cache reused' : 'Not reused'} />}
            </Card>
          )}
        </>
      )}
    </>
  )
}

export function ChatUsage({ id }: { id: string }) {
  const { data } = useRpc('chat.details', { id })
  return (
    <ContextCard
      c={data?.context ?? null}
      speed={data?.speed}
      onCompact={
        data?.canCompact
          ? () => {
              app.set((s) => ({ compacting: { ...s.compacting, [id]: true } }))
              void act('chat.compact', { id }, 'Compacting the conversation…')
            }
          : undefined
      }
    />
  )
}

/** A light highlighter: keywords, strings, numbers, comments. Text only. */
const KW = /\b(func|function|return|if|else|for|while|const|let|var|import|export|from|package|type|struct|interface|class|def|async|await|new|nil|null|true|false|None|True|False|switch|case|break|continue|go|defer|try|catch|throw|in|of|pub|fn|use|mod|impl|self|this)\b/
function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\/\/.*$|#.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index))
    const tok = m[0]
    const cls = tok.startsWith('//') || (tok.startsWith('#') && !/^#\w+\[/.test(tok)) ? 'cm' : /^["'`]/.test(tok) ? 'st' : /^\d/.test(tok) ? 'nu' : KW.test(tok) && tok.match(KW)?.[0] === tok ? 'kw' : null
    out.push(cls ? <span key={k++} className={cls}>{tok}</span> : tok)
    last = m.index + tok.length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

const FILE_NOTE: Record<Exclude<CoworkFileResult['status'], 'ready'>, string> = {
  oversized: 'This file is too large to show.',
  binary: 'This is a binary file.',
  sensitive: 'This file may hold secrets; open it on the computer.',
  denied: 'This file is outside what the session may read.',
  missing: 'This file could not be read.',
}

/** CoworkCodePanel, read-only: explorer, open-file tabs, the path toolbar,
 * the stale banner, change markers, and "Add to chat". */

export function CodeTab({ id }: { id: string }) {
  const state = useApp((s) => s.code[id]) ?? { open: [], active: null }
  const changes = useRpc('cowork.changes', { id })
  const active = state.active
  const file = useRpc('cowork.file', { id, path: active ?? '' }, Boolean(active))
  const [wrap, setWrap] = useState(false)
  const [seen, setSeen] = useState<Record<string, string>>({})
  const [sel, setSel] = useState<[number, number] | null>(null)
  const f = file.data
  const lines = useMemo(() => (f?.content ?? '').split('\n'), [f?.content])
  const touched = new Set(f?.touched ?? (changes.data?.files.map((x) => x.path) ?? []))
  const stale = Boolean(f && active && seen[active] !== undefined && seen[active] !== f.content)
  if (f && active && seen[active] === undefined && f.status === 'ready') setSeen((m) => ({ ...m, [active]: f.content }))
  const setCode = (open: string[], next: string | null) => app.set((s) => ({ code: { ...s.code, [id]: { open, active: next } } }))
  const close = (p: string) => {
    const open = state.open.filter((x) => x !== p)
    setCode(open, active === p ? (open[open.length - 1] ?? null) : active)
  }
  const pick = (n: number) => setSel((cur) => (!cur ? [n, n] : cur[0] === cur[1] && n > cur[0] ? [cur[0], n] : [n, n]))
  const range = sel ? (sel[0] === sel[1] ? `L${sel[0]}` : `L${sel[0]}–${sel[1]}`) : null
  const copy = (text: string, done: string) => void navigator.clipboard?.writeText(text).then(() => toast(done), () => toast('Copy failed'))
  return (
    <>
      <div className="kv" style={{ fontSize: 12 }}>
        <button type="button" className="btn sm" onClick={() => openSheet('files', { id })}>
          <I n="tree" size={13} />
          Project explorer
        </button>
        <span className="muted">{state.open.length} open</span>
      </div>
      {state.open.length > 0 && (
        <div className="ctabs" role="tablist">
          {state.open.map((p) => (
            <span key={p} role="tab" aria-selected={p === active} className={`ctab${p === active ? ' on' : ''}`} onClick={() => setCode(state.open, p)}>
              {p.split('/').pop()}
              {touched.has(p) && <span className="mdot">M</span>}
              <button type="button" className="ib" style={{ width: 18, height: 18 }} aria-label={`Close ${p}`} onClick={(e) => { e.stopPropagation(); close(p) }}>
                <I n="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {!active && (
        <>
          <Empty icon={<I n="code" size={18} />}>Open a file from the explorer or from the session&apos;s changes.</Empty>
          {(changes.data?.files ?? []).map((x) => (
            <button key={x.path} type="button" className="row" onClick={() => setCode(state.open.includes(x.path) ? state.open : [...state.open, x.path], x.path)}>
              <span className="tx"><b className="mono" style={{ fontSize: 12 }}>{x.path}</b></span>
              <span className="add">+{x.additions}</span>
              <span className="del">−{x.deletions}</span>
            </button>
          ))}
        </>
      )}
      {active && (
        <>
          <div className="ctool">
            <span className="mono">{active}</span>
            <button type="button" className="ib" aria-label="Toggle word wrap" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}><I n="wrap" size={14} /></button>
            <button type="button" className="ib" aria-label="Copy code" onClick={() => copy(f?.content ?? '', 'Copied')}><I n="copy" size={14} /></button>
          </div>
          {stale && (
            <div className="stale">
              The agent changed this file since you opened it.
              <button type="button" className="btn sm" onClick={() => setSeen((m) => ({ ...m, [active]: f?.content ?? '' }))}>Reload</button>
            </div>
          )}
          {file.loading && !f && <Empty>Loading…</Empty>}
          {file.error && <Empty>{file.error.message}</Empty>}
          {f && f.status !== 'ready' && <Empty>{FILE_NOTE[f.status]}</Empty>}
          {f && f.status === 'ready' && (
            <div className={`code${wrap ? ' wrap' : ''}`} data-testid="code-view" aria-label={`${active} · ${f.language}`}>
              {(stale ? (seen[active] ?? '').split('\n') : lines).map((text, i) => {
                const n = i + 1
                const mark = stale ? undefined : f.changed[n]
                const on = sel && n >= sel[0] && n <= sel[1]
                return (
                  <div key={n} className={`cl${mark ? ` g${mark}` : ''}${on ? ' sel' : ''}`} onClick={() => pick(n)}>
                    <span className="n">{n}</span>
                    <span className="g" />
                    <span className="t">{highlight(text)}</span>
                  </div>
                )
              })}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn sm" disabled={!range} onClick={() => { if (sel) { insertIntoComposer(`cowork:${id}`, codeRefToken(active, sel[0], sel[1])); toast(`Added ${range} to the message`) } closeAll() }} data-testid="code-add-to-chat">
              Add to chat{range ? ` (${range})` : ''}
            </button>
            <button type="button" className="btn sm" onClick={() => copy(active, 'Copied')}>Copy relative path</button>
            <button type="button" className="btn sm ghost" onClick={() => invalidate(['cowork.file'])}>Refresh</button>
          </div>
        </>
      )}
    </>
  )
}

/** CoworkPreviewPanel: the toolbar and a framed, sandboxed preview of the
 * session's artifact; otherwise a notice. */
/** The desktop's live app, through the server: a ticketed same-origin path,
 * sandboxed without `allow-same-origin` (and by the server's CSP), so the
 * page can never reach this app's storage or token. */
export function LivePreview({ id, url }: { id: string; url: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let on = true
    setFailed(null)
    client()
      .rpc('preview.ticket', { id })
      .then((r) => on && setSrc(r.path))
      .catch((e: unknown) => on && setFailed(e instanceof Error ? e.message : 'Not available'))
    return () => {
      on = false
    }
  }, [id, nonce])
  return (
    <>
      <div className="ptool">
        <span className="mono muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{url}</span>
        <button type="button" className="ib" aria-label="Reload" onClick={() => setNonce((n) => n + 1)}><I n="rotate" size={14} /></button>
      </div>
      {failed ? (
        <Empty icon={<I n="monitor" size={18} />}>{failed}. The live app runs on the computer; open it there.</Empty>
      ) : src ? (
        <div className="pframe">
          <iframe key={`${src}-${nonce}`} title="Live preview" src={src} sandbox="allow-scripts allow-forms allow-popups" data-testid="live-frame" />
        </div>
      ) : (
        <Empty>Loading…</Empty>
      )}
    </>
  )
}

export function PreviewTab({ id }: { id: string }) {
  const [path, setPath] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const [mode, setMode] = useState<'live' | 'files'>('live')
  const { data, error, loading } = useRpc('cowork.preview', path ? { id, path } : { id })
  if (loading && !data) return <Empty>Loading…</Empty>
  if (error && !data) return <Empty>{error.message}</Empty>
  if (data?.live && (mode === 'live' || !data.path)) {
    return <>
      {data.path && <Pills items={[{ id: 'live', label: 'Live app' }, { id: 'files', label: 'Files' }]} value={mode} onChange={setMode} />}
      <LivePreview id={id} url={data.live.url} />
    </>
  }
  if (!data?.path) return <Empty icon={<I n="eye" size={18} />}>Nothing to preview yet. Pages, SVGs and documents the session makes show here.</Empty>
  const srcDoc = data.kind === 'html' || data.kind === 'svg' ? data.content : null
  return (
    <>
      {data.live && <Pills items={[{ id: 'live', label: 'Live app' }, { id: 'files', label: 'Files' }]} value={mode} onChange={setMode} />}
      <div className="ptool">
        {data.artifacts.length > 1 ? (
          <select aria-label="Preview file" value={data.path} onChange={(e) => setPath(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
            {data.artifacts.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        ) : (
          <span className="mono muted">{data.path}</span>
        )}
        <button type="button" className="ib" aria-label="Reload" onClick={() => { setNonce((n) => n + 1); invalidate(['cowork.preview']) }}><I n="rotate" size={14} /></button>
        <button type="button" className="ib" aria-label="Copy path" onClick={() => void navigator.clipboard?.writeText(data.path ?? '').then(() => toast('Path copied'), () => toast('Copy failed'))}><I n="copy" size={14} /></button>
      </div>
      {srcDoc ? (
        <div className="pframe">
          {/* No scripts' network and no same-origin: the page cannot reach the phone's session. */}
          <iframe key={nonce} title={`Preview of ${data.path}`} sandbox="allow-scripts" srcDoc={srcDoc} data-testid="preview-frame" />
        </div>
      ) : data.content !== null ? (
        <div className="card2"><pre className="cmd" style={{ margin: 0, maxHeight: 360, overflow: 'auto' }}>{data.content}</pre></div>
      ) : (
        <Empty icon={<I n="monitor" size={18} />}>{data.note ?? 'Open this preview on the computer.'}</Empty>
      )}
    </>
  )
}
