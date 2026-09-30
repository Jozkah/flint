import { ExternalLink, FlintMark, Icon, DownloadButton, Words } from './ui'
import { Frame, Shot } from './Shot'
import { LINKS } from '../lib/site'

const SPARKS: Array<[string, string, string, string]> = [
  ['28%', '0s', '5.2s', '-14px'],
  ['46%', '1.3s', '4.6s', '10px'],
  ['60%', '2.4s', '5.8s', '-6px'],
  ['38%', '3.1s', '4.9s', '16px'],
  ['70%', '0.7s', '5.4s', '8px'],
]

export function Hero() {
  return (
    <section className="hero" id="top">
      <div className="wrap-wide">
        <div className="hero-grid">
          <div>
            <p className="eyebrow rise" style={{ ['--d' as string]: '0ms' }}>
              <span className="dot" />
              Private · Local-first · Open source
            </p>
            <h1 className="h1">
              <Words text="AI that works where your files already live." />
            </h1>
            <p className="lede rise" style={{ ['--d' as string]: '650ms' }}>
              Chat with any model. Hand real work to an agent. Review every command, diff, and decision before it touches your project.
            </p>
            <div className="hero-cta rise" style={{ ['--d' as string]: '780ms' }}>
              <DownloadButton />
              <ExternalLink href={LINKS.repo} className="btn">
                {Icon.github}
                View on GitHub
              </ExternalLink>
            </div>
            <p className="hero-meta rise" style={{ ['--d' as string]: '900ms' }}>
              <b>Windows · macOS · Linux</b>
              <span>Free and open source</span>
              <a className="link" href="#download">
                Install notes
              </a>
            </p>
          </div>
          <div className="hero-mark rise" style={{ ['--d' as string]: '400ms' }} aria-hidden="true">
            <div className="ember">
              {SPARKS.map(([l, d, t, dx], i) => (
                <i key={i} style={{ ['--l' as string]: l, ['--d' as string]: d, ['--t' as string]: t, ['--dx' as string]: dx }} />
              ))}
            </div>
            <FlintMark size={256} eager />
          </div>
        </div>
      </div>
      <div className="wrap-wide">
        <div className="hero-stage">
          <Frame className="main">
            <Shot id="01-overview" alt="Flint's Overview screen: tokens generated, generation speed, tool call success, token throughput by day, latest activity and a table of agent runs." eager sizes={[1480, 92]} />
          </Frame>
          <div className="hero-float">
            <Frame flat>
              <Shot
                id="04-approval"
                region={{ x: 340, y: 270, w: 730, h: 350 }}
                alt="An approval card: Flint wants to run git push in the acme-weather worktree, with Deny and Allow once."
                sizes={[560, 40]}
                eager
              />
            </Frame>
          </div>
        </div>
      </div>
    </section>
  )
}
