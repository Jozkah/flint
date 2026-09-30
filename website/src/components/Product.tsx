import { useEffect, useRef, useState } from 'react'
import { Icon, Reveal, Scrub } from './ui'
import { Frame, Shot, type Region } from './Shot'

export function Trust() {
  return (
    <section aria-label="What Flint is built around">
      <div className="wrap-wide">
        <div className="trust">
          <Reveal>
            <h3>
              {Icon.shield}Local by default
            </h3>
            <p>Your data stays on your machine.</p>
          </Reveal>
          <Reveal delay={90}>
            <h3>
              {Icon.cube}Bring your own models
            </h3>
            <p>Use local or remote models.</p>
          </Reveal>
          <Reveal delay={180}>
            <h3>
              {Icon.diff}Review before changes
            </h3>
            <p>See commands, diffs and decisions before they apply.</p>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

export function Manifesto() {
  return (
    <section className="section" aria-label="Why Flint">
      <div className="wrap">
        <Scrub
          className="scrub-wide"
          text="Flint is a workspace, not a black box. It shows what the model received, asks before it runs anything you have not allowed, and records what actually happened."
        />
      </div>
    </section>
  )
}

export function Ways() {
  return (
    <section className="section" id="product" style={{ paddingTop: 0 }}>
      <div className="wrap-wide">
        <div className="wrap" style={{ padding: 0 }}>
          <p className="eyebrow">
            <span className="dot" />
            Product
          </p>
          <h2 className="h2" style={{ marginTop: 16, maxWidth: '16ch' }}>
            One workspace. Three ways to work.
          </h2>
        </div>
        <div className="ways">
          <article className="way way-cowork">
            <Reveal mask>
              <Frame>
                <Shot
                  id="03-cowork-tools"
                  alt="A Cowork run: tool call cards for edits and a test, an approval card waiting for an answer, and the Changes panel with a diff."
                  sizes={[860, 92]}
                />
              </Frame>
            </Reveal>
            <div className="meta">
              <span className="k">COWORK</span>
              <h3 className="h3">An agent that works on your project</h3>
            </div>
            <p>It reads files, uses tools, runs commands in a sandbox and proposes changes. You approve what it has no grant for and review what it changed.</p>
          </article>
          <article className="way way-rooms">
            <Reveal mask delay={120}>
              <Frame>
                <Shot
                  id="08-room"
                  region={{ x: 1205, y: 66, w: 385, h: 930 }}
                  alt="A Discussion Room control rail: who is speaking, up next, steering actions and the participants with their access."
                  sizes={[400, 60]}
                />
              </Frame>
            </Reveal>
            <div className="meta">
              <span className="k">ROOMS</span>
              <h3 className="h3">Several models, one topic</h3>
            </div>
            <p>Different providers discuss a question with a moderator, budgets and a final synthesis.</p>
          </article>
          <article className="way way-chat">
            <Reveal mask>
              <Frame>
                <Shot
                  id="15-what-flint-is-using"
                  alt="A chat with the Details panel open: context, changes, What Flint is using, available tools and activity."
                  sizes={[860, 92]}
                />
              </Frame>
            </Reveal>
            <div className="meta">
              <span className="k">CHAT</span>
              <h3 className="h3">Questions, files and code, on your machine</h3>
            </div>
            <p>Attach files, keep conversations in projects, split two chats side by side, and see what each reply was built from.</p>
          </article>
        </div>
      </div>
    </section>
  )
}

type Step = { shot: string; region: Region; title: string; body: string; pill?: [string, string]; alt: string }
const R16 = (x: number, y: number, w: number): Region => ({ x, y, w, h: Math.round(w * 0.625) })

const STEPS: Step[] = [
  {
    shot: '05-pr-bar',
    region: R16(270, 70, 560),
    title: 'Give Flint a task',
    body: 'Describe the work in plain language. Flint keeps a todo list and shows its progress while the run goes on.',
    alt: 'A Cowork session: the task as written, then a progress bar that reads 3 of 4 done.',
  },
  {
    shot: '03-cowork-tools',
    region: R16(340, 95, 800),
    title: 'It reads, edits and runs',
    body: 'Every tool call is a card with its input and output. Open one to see exactly what ran and what came back.',
    alt: 'Expanded tool cards: an edit to a test file, then a go test command with its result.',
  },
  {
    shot: '04-approval',
    region: R16(340, 265, 760),
    title: 'Commands without a grant wait for you',
    body: 'The run stops at git push and asks. Allow once, allow in this conversation, or deny. Each option says how long it lasts.',
    pill: ['warn', 'Awaiting approval'],
    alt: 'An approval card for git push with Deny and Allow once, and the options Allow in this conversation and Always allow bash.',
  },
  {
    shot: '10-queued-messages',
    region: R16(300, 500, 800),
    title: 'Steer while it works',
    body: 'Redirect the run or queue the next instruction without stopping it.',
    alt: 'The composer with two waiting messages: one marked Steering and one marked Steer now.',
  },
  {
    shot: '03-cowork-tools',
    region: R16(1040, 190, 560),
    title: 'Changes stay in a worktree',
    body: 'Flint works in its own copy. Nothing reaches your folder until you apply it, file by file or hunk by hunk.',
    alt: 'The Output panel: a note that the run works in its own copy, Review changes and Export as patch, and the files changed.',
  },
  {
    shot: '06-what-changed',
    region: R16(540, 60, 760),
    title: 'Flint records what happened',
    body: 'Files changed, checks that really ran, and what the model only claimed, kept apart.',
    pill: ['ok', 'Completed'],
    alt: 'The What changed card: what happened, where the result is, and what was checked.',
  },
  {
    shot: '05-pr-bar',
    region: { x: 0, y: 0, w: 1600, h: 1000 },
    title: 'Then open the pull request',
    body: 'Create it from the session, or discard the worktree. Every session keeps its own branch.',
    alt: 'Two Cowork sessions side by side, each with a worktree bar offering Open folder, Merge, Create pull request and Discard.',
  },
]

export function CoworkStory() {
  const [active, setActive] = useState(0)
  const refs = useRef<Array<HTMLElement | null>>([])

  useEffect(() => {
    if (!('IntersectionObserver' in window)) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i))
      },
      { rootMargin: '-42% 0px -42% 0px' },
    )
    refs.current.forEach((el) => el && io.observe(el))
    return () => io.disconnect()
  }, [])

  return (
    <section className="section" id="cowork">
      <div className="wrap-wide">
        <div className="story-head">
          <p className="eyebrow">
            <span className="dot" />
            Cowork
          </p>
          <h2 className="h2" style={{ maxWidth: '17ch' }}>
            From idea to pull request, without losing control.
          </h2>
        </div>
        <div className="story">
          <div className="stage">
            <div className="frame spot">
              {STEPS.map((s, i) => (
                <div key={i} className={`lay ${i === active ? 'on' : ''}`} style={{ position: 'absolute', inset: 0 }} aria-hidden={i !== active}>
                  <Shot id={s.shot} region={s.region} alt={s.alt} sizes={[760, 92]} eager={i === 0} style={{ height: '100%' }} />
                </div>
              ))}
              <div style={{ aspectRatio: '16 / 10' }} />
            </div>
          </div>
          <ol className="steps">
            <div className="story-rail" aria-hidden="true">
              <i />
            </div>
            {STEPS.map((s, i) => (
              <li
                key={i}
                ref={(el) => {
                  refs.current[i] = el
                }}
                data-i={i}
                className={`step ${i === active ? 'on' : ''}`}
              >
                <span className="idx">STEP {i + 1} OF {STEPS.length}</span>
                {s.pill && <span className={`pill ${s.pill[0]}`} style={{ alignSelf: 'flex-start' }}>{s.pill[1]}</span>}
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}

export function Approvals() {
  return (
    <section className="section" id="review">
      <div className="wrap-wide">
        <div className="split rev">
          <div className="stack">
            <Reveal>
              <p className="eyebrow">
                <span className="dot" />
                Approvals
              </p>
              <h2 className="h2" style={{ marginTop: 16 }}>
                Nothing changes until you can see it.
              </h2>
              <p className="lede" style={{ marginTop: 22 }}>
                Review commands before they run. Inspect real file changes before they reach your project.
              </p>
            </Reveal>
            <Reveal delay={100}>
              <div className="opts">
                <div className="opt">
                  <h4>
                    Allow once <span className="pill plain">Not saved</span>
                  </h4>
                  <p>Only this request. Flint asks again next time.</p>
                </div>
                <div className="opt">
                  <h4>
                    Allow in this conversation <span className="pill plain">Until you revoke it</span>
                  </h4>
                  <p>This tool, in this conversation.</p>
                </div>
                <div className="opt">
                  <h4>
                    Always allow <span className="pill warn">Broader</span>
                  </h4>
                  <p>In every conversation, until you revoke it.</p>
                </div>
              </div>
            </Reveal>
          </div>
          <Reveal mask>
            <div style={{ position: 'relative' }}>
              <Frame>
                <Shot
                  id="04-approval"
                  region={{ x: 318, y: 262, w: 790, h: 494 }}
                  alt="An approval card for git push: what it affects, why, what allowing it means, and the options Deny, Allow once, Allow in this conversation and Always allow."
                  sizes={[760, 92]}
                />
              </Frame>
              <span className="pin" style={{ ['--x' as string]: '24%', ['--y' as string]: '30%' }} aria-hidden="true">1</span>
              <span className="pin" style={{ ['--x' as string]: '86%', ['--y' as string]: '42%' }} aria-hidden="true">2</span>
              <span className="pin" style={{ ['--x' as string]: '26%', ['--y' as string]: '62%' }} aria-hidden="true">3</span>
            </div>
            <p className="caption" style={{ marginTop: 14 }}>
              <b style={{ color: 'var(--fg-2)' }}>1</b> Why the command is needed and what allowing it means. <b style={{ color: 'var(--fg-2)' }}>2</b> Deny is one click; Allow once is the default. <b style={{ color: 'var(--fg-2)' }}>3</b> Wider grants are labelled Broader.
            </p>
          </Reveal>
        </div>
        <div className="split even" style={{ marginTop: 'clamp(72px, 9vw, 140px)' }}>
          <Reveal mask>
            <Frame>
              <Shot
                id="13-permissions"
                alt="The Permissions page: tools allowed in one conversation, tools allowed in every conversation, folder access, trusted MCP servers and approvals that need renewing, each with Revoke."
                sizes={[620, 92]}
              />
            </Frame>
          </Reveal>
          <Reveal delay={100} className="stack">
            <h3 className="h3">Every standing grant is listed, and every one can be revoked.</h3>
            <p className="body">The Permissions page shows what you have allowed, where, and for how long. If an MCP server changes after you trusted it, the old approval stops applying and Flint says why.</p>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

export function WhatChanged() {
  return (
    <section className="section" style={{ paddingTop: 0 }}>
      <div className="wrap-wide">
        <div className="split">
          <div className="stack">
            <Reveal>
              <p className="eyebrow">
                <span className="dot" />
                What changed
              </p>
              <h2 className="h2" style={{ marginTop: 16 }}>
                Know what actually happened.
              </h2>
              <p className="lede" style={{ marginTop: 22 }}>
                The summary at the end of a run is recorded by Flint, not written by the model. Only real test, build and lint commands count as checks.
              </p>
            </Reveal>
            <Reveal delay={100}>
              <ul className="opts" style={{ listStyle: 'none' }}>
                <li className="opt">
                  <h4>
                    <span className="pill ok">Passed</span> Judged by exit status
                  </h4>
                  <p>Flint says when only part of a test suite ran.</p>
                </li>
                <li className="opt">
                  <h4>Mentioned by the assistant, not verified by Flint</h4>
                  <p>What the model claims is labelled as a claim, apart from what ran.</p>
                </li>
              </ul>
            </Reveal>
          </div>
          <Reveal mask>
            <Frame>
              <Shot
                id="06-what-changed"
                region={{ x: 556, y: 56, w: 740, h: 688 }}
                alt="The What changed card of a finished run: what happened, where the result is, files changed in a separate worktree, what was checked, and what the assistant claimed that Flint did not verify."
                sizes={[700, 92]}
              />
            </Frame>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

const PROV = [
  ['Model', 'Which model answered, and whether it is remote.'],
  ['Instructions', 'The assistant’s instructions, sent as the system prompt.'],
  ['Memory', 'Saved memory chosen for the last request.'],
  ['Tools', 'Which tools are enabled for the conversation.'],
  ['Attachments', 'Files and text that came with the message.'],
  ['Context', 'How much of the window is used, and whether it compacts.'],
]

export function Provenance() {
  return (
    <section className="section" style={{ paddingTop: 0 }}>
      <div className="wrap-wide">
        <div className="split rev">
          <div>
            <Reveal>
              <p className="eyebrow">
                <span className="dot" />
                What Flint is using
              </p>
              <h2 className="h2" style={{ marginTop: 16 }}>
                Know what your model knows.
              </h2>
              <p className="lede" style={{ marginTop: 22 }}>
                For each reply, open What Flint is using: what applied, and whether it was in the request that was actually sent.
              </p>
            </Reveal>
            <Reveal delay={80}>
              <ul className="prov-list">
                {PROV.map(([t, d]) => (
                  <li key={t}>
                    <b>{t}</b>
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
          <Reveal mask>
            <div style={{ maxWidth: 440, marginInline: 'auto' }}>
              <Frame>
                <Shot
                  id="15-what-flint-is-using"
                  region={{ x: 1250, y: 66, w: 340, h: 930 }}
                  alt="The Details panel: context usage, changes, and What Flint is using with the model, instructions and saved memory, each marked as sent or chosen for the last request."
                  sizes={[440, 80]}
                />
              </Frame>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
