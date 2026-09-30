import { ExternalLink, Icon, Reveal } from './ui'
import { Frame, Shot } from './Shot'
import { LINKS } from '../lib/site'

export function Models() {
  return (
    <section className="section" id="models" style={{ paddingTop: 0 }}>
      <div className="wrap-wide">
        <div className="split">
          <Reveal className="stack">
            <p className="eyebrow">
              <span className="dot" />
              Models
            </p>
            <h2 className="h2" style={{ marginTop: 16 }}>
              Your models. Your choice.
            </h2>
            <p className="lede" style={{ marginTop: 22 }}>
              Run models on this machine, or connect a provider with your own key. Flint never switches to a cloud provider on its own.
            </p>
          </Reveal>
          <Reveal delay={100}>
            <div className="opts" style={{ marginTop: 0 }}>
              <div className="opt">
                <h3>GGUF, through the bundled llama.cpp engine</h3>
                <p>You bring the model files. Nothing is downloaded for you.</p>
              </div>
              <div className="opt">
                <h3>MLX on Apple silicon</h3>
                <p>Local models on macOS need an M1 or later. Intel Macs can use cloud providers.</p>
              </div>
              <div className="opt">
                <h3>OpenAI-compatible and Anthropic-compatible providers</h3>
                <p>Or point Flint at a server on your network. Keys are kept in the OS keyring.</p>
              </div>
            </div>
          </Reveal>
        </div>
        <div style={{ marginTop: 'clamp(40px, 6vw, 80px)' }}>
          <Reveal mask>
            <Frame>
              <Shot
                id="09-models"
                alt="The Models page: installed, loaded and disk totals, three loaded local models with live speed, provider cards for Llama.cpp, Anthropic, OpenAI, Gemini, OpenRouter, Mistral and Groq, and a custom provider slot."
                sizes={[1480, 92]}
              />
            </Frame>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

export function Rooms() {
  return (
    <section className="section" id="rooms" style={{ paddingTop: 0 }}>
      <div className="wrap-wide">
        <div className="split">
          <Reveal className="stack">
            <p className="eyebrow">
              <span className="dot" />
              Discussion Rooms
            </p>
            <h2 className="h2" style={{ marginTop: 16 }}>
              More than one model. One room.
            </h2>
            <p className="lede" style={{ marginTop: 22 }}>
              Put several models from different providers in one room to work on a question, with you in control of the discussion.
            </p>
          </Reveal>
          <Reveal delay={100}>
            <ul className="prov-list" style={{ marginTop: 0 }}>
              <li>
                <b>A moderator and speaking policies</b>
                <span>Round-robin, or you choose who speaks next.</span>
              </li>
              <li>
                <b>@mentions, votes and a synthesis</b>
                <span>Address a participant, call a vote, then ask for a summary with the dissent.</span>
              </li>
              <li>
                <b>Budgets and limits per room</b>
                <span>Turns, rounds, tokens, cost and time, shown at the top.</span>
              </li>
              <li>
                <b>Optional tools and files</b>
                <span>Read-only or read and edit access in a folder you pick. Every tool call shows as a chip.</span>
              </li>
            </ul>
          </Reveal>
        </div>
        <div className="rooms-stage">
          <Reveal mask>
            <Frame>
              <Shot
                id="08-room"
                alt="A Discussion Room: three models discuss a retry policy with tool chips, a vote, and a turn, round, token, cost and time counter."
                sizes={[1480, 92]}
              />
            </Frame>
          </Reveal>
          <Reveal delay={160} className="rooms-inset">
            <Frame flat>
              <Shot
                id="07-rooms"
                region={{ x: 266, y: 130, w: 800, h: 330 }}
                alt="The Rooms page: one room running, one waiting for you, turns this week and models taking part."
                sizes={[520, 60]}
              />
            </Frame>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

const FEATURES = [
  'Managed Git worktrees',
  'Per-hunk review',
  'Checkpoints and rewind',
  'Plan mode',
  'Parallel sub-agents',
  'Six built-in agent roles',
  'Shared task board',
  'Tool timeline and replay',
  'Audit export',
  'Token and cost dashboard',
  'Spend budgets',
  'Split conversations',
  'Temporary chats',
  'MCP servers',
  'Skills and plugins',
  'Memory you review before saving',
  'Secret scan on diffs',
  'Command palette',
  'Custom shortcuts',
  'Command line',
]

function Row({ items, reverse }: { items: string[]; reverse?: boolean }) {
  const list = [...items, ...items]
  return (
    <div className={`marquee ${reverse ? 'r' : ''}`} aria-hidden={reverse ? true : undefined}>
      <div className="track" style={{ ['--dur' as string]: reverse ? '90s' : '80s' }}>
        {list.map((t, i) => (
          <span className="chip" key={i}>
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}

export function Features() {
  const half = Math.ceil(FEATURES.length / 2)
  return (
    <section className="section-tight" aria-label="More of what Flint does">
      <div className="wrap-wide" style={{ marginBottom: 28 }}>
        <p className="eyebrow">
          <span className="dot" />
          And the rest
        </p>
        <ul className="sr-only">
          {FEATURES.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
      <Row items={FEATURES.slice(0, half)} />
      <Row items={FEATURES.slice(half)} reverse />
    </section>
  )
}

export function Bento() {
  return (
    <section className="section" style={{ paddingBottom: 0 }}>
      <div className="wrap-wide">
        <h2 className="h2" style={{ maxWidth: '15ch' }}>
          A desktop app, built like one.
        </h2>
        <div className="bento">
          <article className="tile tilt t1">
            <div className="txt">
              <h3 className="h3">Steer a run while it works</h3>
              <p>Queue the next instruction, or redirect the current one, without stopping the agent.</p>
            </div>
            <div className="pic">
              <Frame>
                <Shot id="10-queued-messages" region={{ x: 300, y: 620, w: 800, h: 380 }} alt="The composer with a steering message and a queued message waiting while the run works." sizes={[700, 80]} />
              </Frame>
            </div>
          </article>
          <article className="tile tilt t2">
            <div className="txt">
              <h3 className="h3">Tools and MCP servers</h3>
              <p>See which servers are connected, how often they are called, and which ones ask first.</p>
            </div>
            <div className="pic">
              <Frame>
                <Shot id="12-tools-mcp" region={{ x: 266, y: 120, w: 820, h: 512 }} alt="MCP server cards with connection state, calls per minute and an auto-approve switch." sizes={[520, 80]} />
              </Frame>
            </div>
          </article>
          <article className="tile tilt t3">
            <div className="txt">
              <h3 className="h3">A library of what runs produce</h3>
              <p>Documents, code, pages and media from Cowork sessions, with a link back to the session.</p>
            </div>
            <div className="pic">
              <Frame>
                <Shot id="14-library" region={{ x: 266, y: 330, w: 1000, h: 520 }} alt="The Library page with artifact cards: markdown, code, an HTML page, a chart and an API guide." sizes={[560, 80]} />
              </Frame>
            </div>
          </article>
          <article className="tile tilt t4">
            <div className="txt">
              <h3 className="h3">Dark and light</h3>
              <p>The same workspace in either theme, with the Code panel, blame and change markers.</p>
            </div>
            <div className="pic">
              <Frame>
                <Shot id="11-code-panel-light" region={{ x: 266, y: 60, w: 1310, h: 600 }} alt="The Code panel in the light theme: an edited file with change markers in the gutter." sizes={[760, 80]} />
              </Frame>
            </div>
          </article>
        </div>
      </div>
    </section>
  )
}

export function LocalFirst() {
  return (
    <section className="section" id="security">
      <div className="wrap-wide">
        <div className="split">
          <div className="stack">
            <Reveal>
              <p className="eyebrow">
                <span className="dot" />
                Local-first
              </p>
              <h2 className="h2" style={{ marginTop: 16 }}>
                Built for your machine, not ours.
              </h2>
              <p className="lede" style={{ marginTop: 22 }}>
                Flint only reaches the network when you add a cloud provider key, a remote MCP server, or turn on web search.
              </p>
            </Reveal>
          </div>
          <Reveal delay={100}>
            <div className="cfg" role="group" aria-label="What Flint does and does not do on your machine">
              <div className="cfg-bar">
                <i />
                <i />
                <i />
                <span style={{ marginLeft: 8 }}>flint / privacy</span>
              </div>
              <dl>
                <div className="r">
                  <dt>telemetry</dt>
                  <dd>
                    <span className="no">on</span> none
                  </dd>
                </div>
                <div className="r">
                  <dt>analytics</dt>
                  <dd>
                    <span className="no">on</span> none
                  </dd>
                </div>
                <div className="r">
                  <dt>update checks</dt>
                  <dd>
                    <span className="no">on</span> none
                  </dd>
                </div>
                <div className="r">
                  <dt>credentials</dt>
                  <dd>
                    stored in the <span className="ok">OS keyring</span>
                  </dd>
                </div>
                <div className="r">
                  <dt>local models</dt>
                  <dd>GGUF (llama.cpp) and MLX run <span className="ok">on this device</span></dd>
                </div>
                <div className="r">
                  <dt>request log</dt>
                  <dd>what the model was sent, and where every request went</dd>
                </div>
              </dl>
            </div>
          </Reveal>
        </div>
        <Reveal>
          <div style={{ marginTop: 'clamp(48px, 6vw, 88px)' }}>
            <h3 className="h3">Commands run in an operating system sandbox.</h3>
            <p className="body" style={{ marginTop: 10 }}>
              Shell commands are confined with the platform’s own mechanism.
            </p>
            <div className="sb">
              <div>
                <b>Linux</b>
                <span>bubblewrap</span>
              </div>
              <div>
                <b>macOS</b>
                <span>Seatbelt</span>
              </div>
              <div>
                <b>Windows</b>
                <span>AppContainer</span>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

export function OpenSource() {
  return (
    <section className="section" style={{ paddingTop: 0 }}>
      <div className="wrap-wide">
        <div className="split">
          <div className="stack">
            <Reveal>
              <p className="eyebrow">
                <span className="dot" />
                Open source
              </p>
              <h2 className="h2" style={{ marginTop: 16 }}>
                Inspect it. Fork it. Change it.
              </h2>
              <p className="lede" style={{ marginTop: 22 }}>
                Flint is open source and built on open foundations.
              </p>
            </Reveal>
            <Reveal delay={90}>
              <ExternalLink href={LINKS.repo} className="repo">
                <span className="top">
                  {Icon.github}
                  Jozkah/flint
                </span>
                <p>A local-first AI workspace for your desktop.</p>
                <span className="tags">
                  <span className="pill plain">Apache License 2.0</span>
                  <span className="pill plain">Tauri + React</span>
                  <span className="pill plain">Rust</span>
                </span>
              </ExternalLink>
              <div className="hero-cta">
                <ExternalLink href={LINKS.repo} className="btn btn-primary">
                  Explore the repository
                </ExternalLink>
                <ExternalLink href={LINKS.docs} className="btn">
                  Read the docs
                </ExternalLink>
              </div>
              <p className="credits" style={{ marginTop: 26 }}>
                Flint is an independent fork of <ExternalLink href={LINKS.jan}>Jan</ExternalLink> and also uses <ExternalLink href={LINKS.llamacpp}>llama.cpp</ExternalLink>, <ExternalLink href={LINKS.tauri}>Tauri</ExternalLink> and <ExternalLink href={LINKS.scalar}>Scalar</ExternalLink>.
              </p>
            </Reveal>
          </div>
          <Reveal mask delay={60}>
            <div style={{ maxWidth: 460, marginInline: 'auto' }}>
            <Frame>
              <Shot id="02-code-panel" region={{ x: 1150, y: 190, w: 440, h: 400 }} alt="Flint's Code panel showing a TypeScript file with change markers in the gutter and a Save button." sizes={[460, 92]} />
            </Frame>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
