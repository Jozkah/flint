// Every menu is a bottom sheet. Each sheet reads what it shows from the
// computer; anything that would change the computer goes through `act`, so
// a refusal (for now, `not_implemented`) is shown rather than faked.
import { useMemo, useState, type ReactNode } from 'react'
import type { RemoteApproval, RemoteModel, SessionKind } from '@/lib/remote/protocol'
import { Avatar, Grab, Kv, Opt, Sw, FlintMark } from '../ui/bits'
import { I, type IconId } from '../ui/icons'
import {
  act,
  app,
  closeSheet,
  go,
  notYet,
  openSheet,
  toast,
  useApp,
  type AppState,
} from '../state/app'
import { useRpc } from '../state/rpc'
import { reachLabel, useSessions } from '../state/sessions'
import { COWORK_MODES, ACCESS_MODES, LEVELS } from './labels'

type Props = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <>
      <Grab />
      <h3>{children}</h3>
      {sub && <p className="sh">{sub}</p>}
    </>
  )
}

function Actions({ items }: { items: [IconId, string, (() => void)?][] }) {
  return (
    <>
      {items.map(([icon, label, fn]) => (
        <button
          key={label}
          type="button"
          className={`opt${icon === 'trash' ? ' dang' : ''}`}
          onClick={() => {
            closeSheet()
            if (fn) fn()
            else notYet(label)
          }}
        >
          <I n={icon} />
          <span className="tx">
            <b>{label}</b>
          </span>
        </button>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------

function ModelSheet({ props }: { props: Props }) {
  const target = str(props.for) ?? 'home'
  const { data, loading } = useRpc('models.list', {})
  const current = useApp((s) => s.composer.model)
  const [q, setQ] = useState('')
  const models = (data?.models ?? []).filter(
    (m) => !q || `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q.toLowerCase())
  )
  const favorites = models.filter((m) => m.favorite)
  const local = models.filter((m) => m.local && !m.favorite)
  const cloud = models.filter((m) => !m.local && !m.favorite)
  const pick = (m: RemoteModel) => {
    if (target === 'home') {
      app.set((s) => ({ composer: { ...s.composer, model: { id: m.id, provider: m.provider, name: m.name } } }))
      closeSheet()
      toast(`Switched to ${m.name}`)
    } else {
      closeSheet()
      void act('settings.set', { scope: target, id: str(props.id), model: { id: m.id, provider: m.provider } })
    }
  }
  const row = (m: RemoteModel) => (
    <Opt
      key={`${m.provider}/${m.id}`}
      title={m.name}
      sub={`${m.providerName ?? m.provider}${m.local ? ' · Runs on this computer' : ''}${m.loaded ? ' · Loaded' : ''}`}
      selected={current?.id === m.id && current.provider === m.provider}
      lead={<Avatar id={m.id} name={m.name} provider={m.provider} size={28} square />}
      onClick={() => pick(m)}
    />
  )
  return (
    <>
      <Title>Model</Title>
      <div className="sin">
        <I n="search" />
        <input placeholder="Search models..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" />
      </div>
      {loading && !data && <p className="sh">Loading models…</p>}
      {favorites.length > 0 && (
        <div className="ssec" style={{ justifyContent: 'flex-start', gap: 4 }}>
          Favorites <I n="star" size={12} />
        </div>
      )}
      {favorites.map(row)}
      {local.length > 0 && <div className="ssec">On this computer or your network</div>}
      {local.map(row)}
      {cloud.length > 0 && (
        <div className="ssec">
          Cloud providers <em>messages leave this computer</em>
        </div>
      )}
      {cloud.map(row)}
      {data && models.length === 0 && <p className="sh">No models match.</p>}
      <div className="ssec" />
      <Opt
        title="Parameters"
        sub="Output, context, compaction, sampling"
        lead={<I n="sliders" />}
        trail={<I n="chevr" style={{ color: 'var(--subtle-foreground)' }} />}
        onClick={() => openSheet('params', props)}
      />
    </>
  )
}

function ReasonSheet({ props }: { props: Props }) {
  const target = str(props.for) ?? 'home'
  const composer = useApp((s) => s.composer)
  const local = props.local === true || (target === 'home' && Boolean(composer.model && isLocalProvider(composer.model.provider)))
  const where = target === 'cowork' ? 'this Cowork session' : target === 'room' ? 'this participant' : 'this chat'
  const set = (patch: Partial<AppState['composer']>, label: string) => {
    if (target === 'home') {
      app.set((s) => ({ composer: { ...s.composer, ...patch } }))
      closeSheet()
      toast(label)
    } else {
      closeSheet()
      void act('settings.set', { scope: target, id: str(props.id), ...patch })
    }
  }
  return (
    <>
      <Title sub={<>for {where}</>}>Reasoning</Title>
      {(
        [
          ['auto', 'Auto', "Reasoning uses the model's default."],
          ['on', 'On', 'Reasoning forced on for every request.'],
          ['off', 'Off', 'Reasoning disabled for every request.'],
        ] as const
      ).map(([id, t, s]) => (
        <Opt key={id} title={t} sub={s} selected={composer.reason === id} onClick={() => set({ reason: id }, `Reasoning: ${t}`)} />
      ))}
      {local ? (
        <>
          <div className="ssec">
            Thinking Budget <em>llama.cpp · share of the context</em>
          </div>
          <div className="lvl" style={{ padding: 0 }}>
            {LEVELS.map(([l, hint]) => (
              <button
                key={l}
                type="button"
                aria-pressed={composer.budget === l}
                onClick={() => set({ budget: l }, `Thinking Budget: ${l}`)}
              >
                {l}
                <small>{hint}</small>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="ssec">
            Reasoning effort <em>Set for {where}</em>
          </div>
          <div className="lvl" style={{ padding: 0 }}>
            {(['Low', 'Medium', 'High'] as const).map((l) => (
              <button key={l} type="button" aria-pressed={false} onClick={() => set({}, `Reasoning effort: ${l}`)}>
                {l}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="kv" style={{ marginTop: 6 }}>
        <span>Model default</span>
        <button type="button" className="btn sm ghost" onClick={() => set({ reason: 'auto', budget: 'Unlimited' }, 'Reset to global')}>
          Reset to global
        </button>
      </div>
    </>
  )
}

const isLocalProvider = (p: string) => p === 'llamacpp' || p === 'mlx' || p === 'ollama'

function ModeSheet({ props }: { props: Props }) {
  const current = str(props.value) ?? app.get().composer.cwMode
  const id = str(props.id)
  return (
    <>
      <Title>What Flint may do</Title>
      {COWORK_MODES.map((m) => (
        <Opt
          key={m.id}
          title={m.label}
          sub={m.sub}
          selected={current === m.id}
          onClick={() => {
            closeSheet()
            if (!id) app.set((s) => ({ composer: { ...s.composer, cwMode: m.id } }))
            else void act('settings.set', { scope: 'cowork', id, mode: m.id })
          }}
        />
      ))}
    </>
  )
}

function AccessSheet({ props }: { props: Props }) {
  const current = str(props.value) ?? app.get().composer.access
  const id = str(props.id)
  return (
    <>
      <Title>Where changes go</Title>
      {ACCESS_MODES.map((m) => (
        <Opt
          key={m.id}
          title={m.label}
          sub={m.sub}
          selected={current === m.id}
          onClick={() => {
            closeSheet()
            if (!id) app.set((s) => ({ composer: { ...s.composer, access: m.id } }))
            else void act('settings.set', { scope: 'cowork', id, access: m.id })
          }}
        />
      ))}
    </>
  )
}

function StopSheet({ props }: { props: Props }) {
  const kind = str(props.kind) as SessionKind | undefined
  const id = str(props.id)
  return (
    <>
      <Title>Stop…</Title>
      <Opt
        title="Stop current task"
        sub="Ends this response and everything under it. Other sessions keep running."
        lead={<I n="sq" />}
        onClick={() => {
          closeSheet()
          void act('run.stop', { kind, id }, 'Stopped.')
        }}
      />
      <Opt
        danger
        title="Stop all activity"
        sub="Ends every run, tool, command and agent everywhere in Flint."
        lead={<I n="alert" />}
        onClick={() => {
          closeSheet()
          void act('run.stop', { all: true }, 'Stopped everything.')
        }}
      />
    </>
  )
}

function PermDetailsSheet({ props }: { props: Props }) {
  const a = props.approval as RemoteApproval | undefined
  if (!a) return <Title>Permission details</Title>
  return (
    <>
      <Title sub="Choose how far this permission goes">Permission details</Title>
      <div className="scopes">
        {a.scopes.map((s, i) => (
          <button
            key={s.scope}
            type="button"
            className={`scope${i === 0 ? ' sug' : ''}`}
            onClick={() => {
              closeSheet()
              void act('approvals.respond', { requestId: a.requestId, decision: 'allow', scope: s.scope }, `${s.label} · from this phone`)
            }}
          >
            <b>
              {s.label}
              {s.broader && (
                <span className="broader">● Broader</span>
              )}
            </b>
            <small>{s.explanation}</small>
          </button>
        ))}
      </div>
      <div className="ssec">Technical details</div>
      <Kv k="Tool" v={<span className="mono">{a.toolName}</span>} />
      <Kv k="Server" v={a.serverName ?? 'Built in'} />
      <div className="cmd">{a.argumentsJson}</div>
      <p className="sh" style={{ margin: 0 }}>
        You can review and revoke permissions in Settings › Permissions.
      </p>
    </>
  )
}

function RunsSheet() {
  const { data } = useRpc('status', {})
  const { sessions } = useSessions()
  const runs = data?.runs ?? []
  return (
    <>
      <Title>Runs in progress</Title>
      {runs.length === 0 && <p className="sh">Nothing is running.</p>}
      {runs.map((r) => {
        const s = sessions.find((x) => x.id === r.id)
        return (
          <Opt
            key={`${r.kind}:${r.id}`}
            title={s?.title ?? 'Untitled'}
            sub={s?.status === 'waiting' ? 'Waiting for approval' : `${r.kind === 'room' ? 'Room' : r.kind === 'cowork' ? 'Cowork' : 'Chat'} · running`}
            lead={<FlintMark size={28} />}
            trail={
              <span className="chip warn live">
                <span className="d" />
                Running
              </span>
            }
            onClick={() => go({ name: r.kind, id: r.id })}
          />
        )
      })}
    </>
  )
}

function ConnSheet() {
  const computer = useApp((s) => s.computerName) ?? 'Your computer'
  const conn = useApp((s) => s.conn)
  const status = useRpc('status', {})
  const sys = useRpc('system.info', {})
  const loaded = status.data?.modelsLoaded ?? 0
  return (
    <>
      <Title>Computers</Title>
      <Opt
        title={computer}
        sub={`${conn === 'connected' ? 'Connected' : conn === 'connecting' ? 'Connecting' : 'Offline'} · ${reachLabel()} · ${loaded} ${loaded === 1 ? 'model' : 'models'} loaded`}
        selected
        lead={
          <span className="logo sq" style={{ width: 30, height: 30, borderRadius: 8 }}>
            <I n="monitor" />
          </span>
        }
      />
      <div className="ssec">{computer}</div>
      <Kv k="Route" v={<span className="mono" style={{ fontSize: 11.5 }}>{location.host}</span>} />
      <Kv k="Reachable through" v={reachLabel()} />
      <Kv
        k="Local API"
        v={
          sys.data ? (
            <span style={{ color: sys.data.localApi.running ? 'var(--success)' : undefined }}>
              {sys.data.localApi.running ? 'On' : 'Off'}
            </span>
          ) : (
            '—'
          )
        }
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 4 }}>
        <button type="button" className="btn" onClick={() => go({ name: 'system' })}>
          System Monitor
        </button>
        <button type="button" className="btn" onClick={() => go({ name: 'remote' })}>
          Remote access
        </button>
        <button
          type="button"
          className="btn"
          style={{ gridColumn: '1/-1' }}
          onClick={() => toast('Scan the QR code in Settings › Remote access on the other computer')}
        >
          <I n="qr" size={14} />
          Pair another computer
        </button>
      </div>
    </>
  )
}

function PaletteSheet() {
  const [q, setQ] = useState('')
  const { sessions } = useSessions()
  const hits = useMemo(
    () => (q ? sessions.filter((s) => s.title.toLowerCase().includes(q.toLowerCase())) : sessions).slice(0, 12),
    [q, sessions]
  )
  const actions: [IconId, string, () => void][] = [
    ['pen', 'New chat', () => go({ name: 'home', mode: 'chat' })],
    ['cowork', 'New Cowork session', () => go({ name: 'home', mode: 'cowork' })],
    ['rooms', 'Rooms', () => go({ name: 'rooms' })],
    ['book', 'Open artifacts', () => go({ name: 'library' })],
    ['monitor', 'Open system monitor', () => go({ name: 'system' })],
  ]
  const shownActions = actions.filter(([, l]) => !q || l.toLowerCase().includes(q.toLowerCase()))
  return (
    <>
      <Grab />
      <div className="sin">
        <I n="search" />
        <input
          placeholder="Type a command, a page or a conversation…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search"
          autoFocus
        />
      </div>
      {shownActions.length > 0 && <div className="ssec">Actions</div>}
      {shownActions.map(([icon, label, fn]) => (
        <Opt key={label} title={label} lead={<I n={icon} />} onClick={fn} />
      ))}
      <div className="ssec">Conversations</div>
      {hits.length === 0 && <p className="sh">Nothing matches “{q}”.</p>}
      {hits.map((s) => (
        <Opt
          key={s.id}
          title={s.title || 'Untitled'}
          sub={s.group}
          lead={<I n={s.kind === 'chat' ? 'pen' : s.kind === 'cowork' ? 'cowork' : 'rooms'} />}
          onClick={() => go({ name: s.kind, id: s.id })}
        />
      ))}
    </>
  )
}

function TokensSheet({ props }: { props: Props }) {
  const used = typeof props.used === 'number' ? props.used : null
  return (
    <>
      <Title>Token usage</Title>
      {used === null ? (
        <p className="sh">Token counts for this conversation aren't sent to the phone yet.</p>
      ) : (
        <Kv k="Last run" v={`${used.toLocaleString()} tokens`} />
      )}
    </>
  )
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`row${on ? ' on' : ''}`} onClick={onClick}>
      <span className="tx">
        <b>{label}</b>
      </span>
      <Sw on={on} />
    </button>
  )
}

function NotifSetSheet() {
  return (
    <>
      <Title sub="Push notifications arrive in a later update. Until then, alerts show while Flint is open on this phone.">
        Notify me when
      </Title>
      {[
        'An approval is waiting',
        'A run finishes',
        'A run fails or stops',
        'A Room is waiting for you',
        'A chat reply finishes',
      ].map((r, i) => (
        <Toggle key={r} label={r} on={i < 4} onClick={() => notYet('Notification settings')} />
      ))}
    </>
  )
}

function CwOptionsSheet({ props }: { props: Props }) {
  const web = useApp((s) => s.composer.web)
  return (
    <>
      <Title sub="This Cowork session">Options</Title>
      <Opt title="Assistant" sub="Flint" lead={<FlintMark size={26} />} trail={<I n="chevr" style={{ color: 'var(--subtle-foreground)' }} />} onClick={() => openSheet('assistant', props)} />
      <Opt title="Sampling" sub="Output, context and compaction" lead={<I n="sliders" />} trail={<I n="chevr" style={{ color: 'var(--subtle-foreground)' }} />} onClick={() => openSheet('params', props)} />
      <Opt title="Tools" lead={<I n="wrench" />} trail={<I n="chevr" style={{ color: 'var(--subtle-foreground)' }} />} onClick={() => openSheet('tools', props)} />
      <button
        type="button"
        className={`row${web ? ' on' : ''}`}
        style={{ padding: '9px 10px' }}
        onClick={() => app.set((s) => ({ composer: { ...s.composer, web: !s.composer.web } }))}
      >
        <I n="globe" />
        <span className="tx">
          <b>Web search</b>
        </span>
        <Sw on={web} />
      </button>
      <Opt title="Reasoning" lead={<I n="bulb" />} trail={<I n="chevr" style={{ color: 'var(--subtle-foreground)' }} />} onClick={() => openSheet('reason', { ...props, for: 'cowork' })} />
      <Opt title="Commands & skills" lead={<I n="slash" />} trail={<I n="chevr" style={{ color: 'var(--subtle-foreground)' }} />} onClick={() => openSheet('skills')} />
    </>
  )
}

function ToolsSheet() {
  const { data } = useRpc('tools.list', {})
  const servers = data?.servers ?? []
  return (
    <>
      <Title sub={`${servers.filter((s) => s.active).length} MCP servers on`}>Available tools</Title>
      {servers.map((s) => (
        <Toggle key={s.name} label={s.name} on={s.active} onClick={() => void act('settings.set', { scope: 'mcp', server: s.name, active: !s.active })} />
      ))}
      {data && servers.length === 0 && <p className="sh">No MCP servers are set up on the computer.</p>}
    </>
  )
}

function ProfileSheet() {
  const profiles: [IconId, string, string][] = [
    ['hammer', 'Execute', 'Build, add or change something: implement a feature, fix a known bug, make the requested edit.'],
    ['scan', 'Review', 'Review, audit or check existing code or a diff for bugs, risks and quality. No changes expected.'],
    ['map', 'Plan', 'Design or plan work before doing it: an approach, architecture, steps, trade-offs, estimates.'],
    ['shuffle', 'Refactor', 'Restructure, clean up, rename, split or simplify code without changing what it does.'],
    ['bug', 'Debug', 'Find out why something fails, crashes or behaves wrongly, and fix the cause.'],
    ['micro', 'Reverse engineer', 'Work out how unfamiliar or undocumented code, binaries, formats or protocols work.'],
    ['book', 'Explain', 'Answer a question or explain how something works; no changes expected.'],
  ]
  const pick = () => {
    closeSheet()
    void act('settings.set', { scope: 'cowork', profile: true })
  }
  return (
    <>
      <Title sub="Adds a short block to the system prompt for the kind of work this session asks for.">Work profile</Title>
      <Opt title="Auto" sub="Jev or a keyword match picks from the first message." selected lead={<span className="pico"><I n="wand" /></span>} onClick={closeSheet} />
      {profiles.map(([icon, t, s]) => (
        <Opt key={t} title={t} sub={s} selected={false} lead={<span className="pico"><I n={icon} /></span>} onClick={pick} />
      ))}
    </>
  )
}

function RoomNewSheet() {
  return (
    <>
      <Title sub="Rooms are set up on the computer for now.">New room</Title>
      <label className="field">
        Title
        <input placeholder="Radar cache TTL" />
      </label>
      <label className="field">
        Objective
        <input placeholder="What should the participants discuss or decide?" />
      </label>
      <button
        type="button"
        className="btn pri big"
        onClick={() => {
          closeSheet()
          void act('room.send', { create: true })
        }}
      >
        Create room
      </button>
    </>
  )
}

const SHEETS: Record<string, (p: { props: Props }) => ReactNode> = {
  model: ModelSheet,
  reason: ReasonSheet,
  mode: ModeSheet,
  access: AccessSheet,
  stop: StopSheet,
  permdetails: PermDetailsSheet,
  runs: RunsSheet,
  conn: ConnSheet,
  palette: PaletteSheet,
  tokens: TokensSheet,
  notifset: NotifSetSheet,
  cwoptions: CwOptionsSheet,
  tools: ToolsSheet,
  profile: ProfileSheet,
  roomnew: RoomNewSheet,
  attach: () => (
    <>
      <Title>Add to this message</Title>
      <Actions
        items={[
          ['image', 'Photo library'],
          ['file', 'Add files or images'],
          ['folder', 'Files on the computer'],
          ['at', 'Reference a file (@)'],
        ]}
      />
    </>
  ),
  assistant: () => (
    <>
      <Title>Assistant</Title>
      <Opt title="Flint" sub="Default" selected lead={<FlintMark size={26} />} onClick={closeSheet} />
      <Opt title="Choose another assistant" sub="Assistants are set up on the computer" lead={<I n="users" />} onClick={() => notYet('Switching assistants')} />
    </>
  ),
  params: () => (
    <>
      <Title sub="Applies to this conversation">Parameters</Title>
      <p className="sh">Max output, context size, compaction and sampling are set on the computer for now.</p>
    </>
  ),
  skills: () => (
    <>
      <Title sub="Tap to insert">Commands &amp; skills</Title>
      {[
        ['/help', 'List available commands'],
        ['/new', 'Start a new conversation'],
        ['/compact', 'Summarize older messages to free the context window'],
      ].map(([c, d]) => (
        <Opt key={c} title={<span className="mono">{c} <span className="bdg">built-in</span></span>} sub={d} onClick={() => notYet('Commands')} />
      ))}
    </>
  ),
  msgmenu: () => (
    <>
      <Title>Message actions</Title>
      <Actions items={[['copy', 'Copy'], ['refresh', 'Regenerate response'], ['edit', 'Edit Message'], ['branch', 'Branch from here'], ['trash', 'Delete']]} />
    </>
  ),
  threadmenu: ({ props }) => (
    <>
      <Title>{str(props.title) ?? 'Chat'}</Title>
      <Actions items={[['edit', 'Rename'], ['pin', 'Pin'], ['group', 'Move to group'], ['copy', 'Copy ID', () => copyId(props)], ['trash', 'Delete']]} />
    </>
  ),
  sessmenu: ({ props }) => (
    <>
      <Title>{str(props.title) ?? 'Cowork session'}</Title>
      <Actions items={[['branch', 'Fork this session'], ['upl', 'Export session…'], ['file', 'File activity…'], ['copy', 'Copy ID', () => copyId(props)], ['trash', 'Delete session']]} />
    </>
  ),
  roommenu: ({ props }) => (
    <>
      <Title>{str(props.title) ?? 'Room'}</Title>
      <Actions
        items={[
          ['pause', 'Pause'],
          ['vote', 'Call vote'],
          ['file', 'Synthesize'],
          ['sq', 'Stop room', () => void act('run.stop', { kind: 'room', id: str(props.id) }, 'Stopped.')],
          ['trash', 'Delete'],
        ]}
      />
    </>
  ),
  coworkmenu: () => (
    <>
      <Title sub="Also opens with a long press on the Cowork row.">Cowork</Title>
      <Actions items={[['group', 'New group'], ['plus', 'New session', () => go({ name: 'home', mode: 'cowork' })], ['upl', 'Import session…']]} />
    </>
  ),
  chatfilter: () => (
    <>
      <Title>Show</Title>
      <Opt title="All" selected onClick={closeSheet} />
      <Opt title="Active" selected={false} onClick={() => notYet('Filtering')} />
    </>
  ),
  workspace: ({ props }) => (
    <>
      <Title>Workspace</Title>
      <div className="ssec">Reads from</div>
      <div className="opt">
        <I n="folder" />
        <span className="tx">
          <b>{str(props.group) ?? 'No folder'}</b>
          {str(props.folder) && <small className="mono">{str(props.folder)}</small>}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
        <button type="button" className="btn" onClick={() => notYet('Changing the folder')}>
          Change folder
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const f = str(props.folder)
            if (f) void navigator.clipboard?.writeText(f).then(() => toast('Path copied'), () => toast('Copy failed'))
          }}
        >
          Copy path
        </button>
      </div>
    </>
  ),
  temp: () => (
    <>
      <Title sub="Temporary chat — won't be saved. Nothing is written to history on the computer.">Temporary chat</Title>
      <button type="button" className="btn pri big" onClick={() => notYet('Temporary chat')}>
        Start temporary chat
      </button>
    </>
  ),
}

function copyId(props: Props) {
  const id = str(props.id)
  if (!id) return
  void navigator.clipboard?.writeText(id).then(
    () => toast('ID copied'),
    () => toast('Copy failed')
  )
}

export function SheetBody({ name, props }: { name: string; props: Props }) {
  const Cmp = SHEETS[name]
  return Cmp ? <Cmp props={props} /> : null
}
