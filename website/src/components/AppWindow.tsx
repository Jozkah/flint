import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Icon, DownloadButton, Words } from './ui'
import { Frame, Shot } from './Shot'
import { asset, LINKS } from '../lib/site'

type Item = { id: string; label: string; blurb: string; alt: string }

const ITEMS: Item[] = [
  { id: '01-overview', label: 'Overview', blurb: 'Tokens, speed, tool calls and every agent run at a glance.', alt: "Flint's Overview screen: tokens generated, generation speed, tool call success, token throughput by day, latest activity and a table of agent runs." },
  { id: '03-cowork-tools', label: 'Cowork', blurb: 'Hand an agent real work. It asks before anything you have not allowed.', alt: 'A Cowork run with an expanded bash result, an approval card waiting for an answer, and the Changes panel showing two changed files.' },
  { id: '02-code-panel', label: 'Code', blurb: 'Every edit lands in a panel beside the chat, with change markers and blame.', alt: 'The Code panel beside a Cowork chat: an edited TypeScript file with change markers in the gutter, Editing and Save controls, and the file tabs.' },
  { id: '06-what-changed', label: 'Review', blurb: 'What changed, what was checked, and what Flint did not verify.', alt: 'The What changed card: what happened, where the result is, what was checked, and what the assistant claimed that Flint did not verify.' },
  { id: '08-room', label: 'Rooms', blurb: 'Put Claude, GPT and Gemini in one room and let them reach a decision.', alt: 'A Discussion Room where Claude, GPT and Gemini discuss a retry policy, with tool chips, a vote and a counter for turns, rounds, tokens, cost and time.' },
  { id: '09-models', label: 'Models', blurb: 'Local GGUF or MLX models, or a hosted provider with your own key.', alt: 'The Models page with totals, three loaded local models with live speed, provider cards and a custom provider slot.' },
  { id: '17-agent-browser', label: 'Browser', blurb: 'A read-only preview of the pages the agent opens.', alt: 'A Cowork run with the Agent browser tab open in the Output panel, showing a read-only preview of a radar status web page.' },
  { id: '16-studio', label: 'Studio', blurb: 'Images on this computer, or a hosted provider marked as leaving it.', alt: 'The Studio page with the model picker open: local models, then OpenAI and Gemini image models marked as leaving this computer.' },
]

const DWELL = 5000

export function AppWindow() {
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    if (paused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = window.setTimeout(() => setI((n) => (n + 1) % ITEMS.length), DWELL)
    return () => window.clearTimeout(t)
  }, [i, paused])

  const pick = (n: number) => {
    setI(n)
    setPaused(true)
  }

  return (
    <section className="app" id="top" ref={ref}>
      <div className="hero-glow" aria-hidden="true" />
      <div className="wrap-wide app-head">
        <h1 className="h1">
          <Words text="AI that works where your files already live." />
        </h1>
        <div className="app-cta rise" style={{ ['--d' as string]: '600ms' }}>
          <p className="lede">Chat with any model, hand real work to an agent, and approve every command before it runs. Local-first, open source.</p>
          <div className="hero-cta" style={{ marginTop: 0 }}>
            <DownloadButton />
            <ExternalLink href={LINKS.repo} className="btn">
              {Icon.github}
              GitHub
            </ExternalLink>
          </div>
        </div>
      </div>
      <div className="wrap-wide">
        <div className="win rise" id="product" style={{ ['--d' as string]: '250ms' }} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
          <div className="win-bar" aria-hidden="true">
            <i /><i /><i />
            <span>Flint · acme-weather</span>
          </div>
          <div className="win-body">
            <nav className="win-side" aria-label="Parts of Flint">
              <div className="win-brand">
                <img src={asset('brand/icon-64.png')} width="22" height="22" alt="" />
                Flint
              </div>
              <ul role="tablist">
                {ITEMS.map((it, n) => (
                  <li key={it.id}>
                    <button
                      role="tab"
                      id={`win-tab-${n}`}
                      aria-selected={i === n}
                      aria-controls="win-panel"
                      tabIndex={i === n ? 0 : -1}
                      className={i === n && !paused ? 'run' : ''}
                      style={{ ['--dwell' as string]: `${DWELL}ms` }}
                      onClick={() => pick(n)}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') pick((i + 1) % ITEMS.length)
                        if (e.key === 'ArrowUp') pick((i + ITEMS.length - 1) % ITEMS.length)
                      }}
                    >
                      <span className="k">{it.label}</span>
                      <span className="b">{it.blurb}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="win-foot">
                <b>Windows · macOS · Linux</b>
                <span>Free, Apache 2.0</span>
              </p>
            </nav>
            <div className="win-stage" role="tabpanel" id="win-panel" aria-labelledby={`win-tab-${i}`}>
              <Frame className="win-frame">
                {ITEMS.map((it, n) => (
                  <div key={it.id} className={`lay ${i === n ? 'on' : ''}`} aria-hidden={i !== n}>
                    <Shot id={it.id} alt={it.alt} eager={n === 0} region={{ x: 208, y: 0, w: 1392, h: 1000 }} sizes={[1300, 92]} />
                  </div>
                ))}
              </Frame>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
