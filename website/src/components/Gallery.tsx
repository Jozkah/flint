import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, Reveal } from './ui'
import { Shot, shotSizes, shotUrl } from './Shot'
import { asset } from '../lib/site'

type Item = { id: string; light?: string; span: string; caption: string; alt: string }

const ITEMS: Item[] = [
  { id: '02-code-panel', light: '11-code-panel-light', span: 'w4', caption: 'Code panel with change markers and blame', alt: 'The Code panel beside a Cowork chat: an edited TypeScript file with change markers in the gutter, Editing and Save controls, and the file tabs.' },
  { id: '04-approval', span: '', caption: 'Approval card with its permission options', alt: 'An approval card for git push with Deny and Allow once, and under More options Allow in this conversation and Always allow bash.' },
  { id: '03-cowork-tools', span: 'w3', caption: 'Tool calls, results and the Changes panel', alt: 'A Cowork run with an expanded bash result, an approval card waiting for an answer, and the Changes panel showing two changed files.' },
  { id: '08-room', span: 'w3', caption: 'A Discussion Room', alt: 'A Discussion Room where Claude, GPT and Gemini discuss a retry policy, with tool chips, a vote and a counter for turns, rounds, tokens, cost and time.' },
  { id: '06-what-changed', span: '', caption: 'What changed', alt: 'The What changed card: what happened, where the result is, what was checked, and what the assistant claimed that Flint did not verify.' },
  { id: '05-pr-bar', span: '', caption: 'Sessions, each in its own worktree', alt: 'Two Cowork sessions side by side, each with its worktree bar and a Create pull request action.' },
  { id: '10-queued-messages', span: '', caption: 'Steering and queued messages', alt: 'The Cowork composer with a steering message and a queued message waiting while the run works.' },
  { id: '09-models', span: 'w4', caption: 'Models: loaded models and providers', alt: 'The Models page with totals, three loaded local models with live speed, provider cards and a custom provider slot.' },
  { id: '16-studio', span: 'w3', caption: 'Studio: images on this computer or a hosted provider', alt: 'The Studio page with the model picker open: local models, then OpenAI and Gemini image models marked as leaving this computer, with Discover and Manage hosted providers links.' },
  { id: '17-agent-browser', span: 'w3', caption: 'The agent browser, previewing a web page', alt: 'A Cowork run with the Agent browser tab open in the Output panel, showing a read-only preview of a radar status web page with its address, tabs and last action.' },
  { id: '07-rooms', span: '', caption: 'Rooms overview', alt: 'The Rooms page with counts for running rooms, rooms waiting for you, turns this week and models taking part, then a card per room.' },
  { id: '12-tools-mcp', span: '', caption: 'Tools and MCP servers', alt: 'The Tools and MCP page: server cards with connection state, call rate, available tools and an auto-approve switch.' },
  { id: '13-permissions', span: '', caption: 'Permissions and revoke', alt: 'The Permissions page listing tools allowed per conversation and everywhere, folder access, trusted MCP servers and approvals that need renewing.' },
  { id: '14-library', span: '', caption: 'Library of Cowork artifacts', alt: 'The Library page with artifact cards for markdown, code, an HTML page, a chart and an API guide.' },
  { id: '15-what-flint-is-using', span: 'w3', caption: 'What Flint is using', alt: 'A chat with the Details panel open: context, changes, What Flint is using, available tools and activity.' },
  { id: '01-overview', span: 'w3', caption: 'Overview', alt: 'The Overview page with tokens generated, generation speed, tool call success, token throughput by day, latest activity and agent runs.' },
]

export function Gallery() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [open, setOpen] = useState<number | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLElement | null>(null)

  const idOf = (i: number) => (theme === 'light' && ITEMS[i].light ? ITEMS[i].light! : ITEMS[i].id)
  const altOf = (i: number) => (theme === 'light' && ITEMS[i].light ? 'The Code panel in the light theme: an edited TypeScript file with change markers in the gutter.' : ITEMS[i].alt)

  const show = useCallback((i: number, el?: HTMLElement) => {
    if (el) opener.current = el
    setOpen(i)
  }, [])
  const step = useCallback((d: number) => setOpen((i) => (i === null ? i : (i + d + ITEMS.length) % ITEMS.length)), [])

  useEffect(() => {
    const dlg = dialog.current
    if (!dlg) return
    if (open !== null && !dlg.open) {
      dlg.showModal()
      document.body.style.overflow = 'hidden'
    }
    if (open === null && dlg.open) dlg.close()
  }, [open])

  useEffect(() => {
    const dlg = dialog.current
    if (!dlg) return
    const onClose = () => {
      document.body.style.overflow = ''
      setOpen(null)
      opener.current?.focus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') step(1)
      if (e.key === 'ArrowLeft') step(-1)
    }
    dlg.addEventListener('close', onClose)
    dlg.addEventListener('keydown', onKey)
    return () => {
      dlg.removeEventListener('close', onClose)
      dlg.removeEventListener('keydown', onKey)
    }
  }, [step])

  const cur = open === null ? null : open
  const curId = cur === null ? null : idOf(cur)
  const e = curId ? shotSizes(curId) : null

  return (
    <section className="section" id="gallery" style={{ paddingTop: 0 }}>
      <div className="wrap-wide">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'end', justifyContent: 'space-between' }}>
          <Reveal>
            <p className="eyebrow">
              <span className="dot" />
              Screenshots
            </p>
            <h2 className="h2" style={{ marginTop: 16 }}>
              The real thing, up close.
            </h2>
          </Reveal>
          <div className="seg" role="group" aria-label="Theme of the first screenshot">
            <button aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
              Dark
            </button>
            <button aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
              Light
            </button>
          </div>
        </div>
        <ul className="gal">
          {ITEMS.map((it, i) => (
            <li key={it.id} className={`gal-item tilt ${it.span}`} style={{ listStyle: 'none' }}>
              <button
                style={{ display: 'block', width: '100%', textAlign: 'left' }}
                aria-label={`Open screenshot: ${it.caption}`}
                onClick={(ev) => show(i, ev.currentTarget)}
              >
                <Shot key={idOf(i)} id={idOf(i)} alt={altOf(i)} sizes={it.span === 'w4' ? [760, 100] : it.span === 'w3' ? [580, 50] : [390, 50]} />
                <span className="cap">{it.caption}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="caption" style={{ marginTop: 22 }}>
          All screenshots are real captures of Flint using an invented example project (“acme-weather”) and made-up data.
        </p>
      </div>
      <dialog ref={dialog} className="lightbox" aria-label="Screenshot viewer">
        {cur !== null && curId && e && (
          <div className="lb">
            <div className="lb-top">
              <span className="caption" aria-live="polite">
                {cur + 1} / {ITEMS.length} · {ITEMS[cur].caption}
              </span>
              <button className="ib" aria-label="Close" onClick={() => setOpen(null)}>
                {Icon.close}
              </button>
            </div>
            <div className="lb-img">
              <picture key={curId}>
                <source type="image/avif" srcSet={e.widths.map((w) => `${asset(`shots/${curId}-${w}.avif`)} ${w}w`).join(', ')} sizes="100vw" />
                <img src={shotUrl(curId, 2560)} width={e.width} height={e.height} alt={altOf(cur)} />
              </picture>
            </div>
            <div className="lb-bot">
              <button className="ib" aria-label="Previous screenshot" onClick={() => step(-1)}>
                {Icon.prev}
              </button>
              <span className="caption">Arrow keys to browse, Esc to close</span>
              <button className="ib" aria-label="Next screenshot" onClick={() => step(1)}>
                {Icon.next}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </section>
  )
}
