import { Icon, Reveal } from './ui'
import { Frame, Shot, type Region } from './Shot'

type Pillar = { icon: keyof typeof Icon; title: string; text: string; id: string; region: Region; alt: string }

const PILLARS: Pillar[] = [
  {
    icon: 'shield',
    title: 'Local by default',
    text: 'Chats, files and models stay on your machine. Nothing leaves unless you add a provider.',
    id: '09-models',
    region: { x: 300, y: 150, w: 760, h: 380 },
    alt: 'Three loaded local models with their live generation speed on the Models page.',
  },
  {
    icon: 'diff',
    title: 'Ask before acting',
    text: 'Every command and file edit shows up as a card you can deny, allow once, or allow always.',
    id: '04-approval',
    region: { x: 330, y: 268, w: 750, h: 375 },
    alt: 'An approval card: Flint wants to run git push in the acme-weather worktree, with Deny and Allow once.',
  },
  {
    icon: 'cube',
    title: 'Bring your own models',
    text: 'A GGUF you already have, a download from Hugging Face, MLX on Apple silicon, or a cloud key.',
    id: '15-what-flint-is-using',
    region: { x: 1030, y: 120, w: 560, h: 280 },
    alt: 'The Details panel listing the model, context and tools that Flint is using for a chat.',
  },
]

export function Pillars() {
  return (
    <section className="section-tight" aria-label="What Flint is built around">
      <div className="wrap-wide">
        <ul className="pillars">
          {PILLARS.map((p, i) => (
            <li key={p.title}>
              <Reveal delay={i * 90} className="pillar tilt">
                <div className="pic">
                  <Frame flat>
                    <Shot id={p.id} region={p.region} alt={p.alt} sizes={[460, 90]} />
                  </Frame>
                </div>
                <h2>
                  {Icon[p.icon]}
                  {p.title}
                </h2>
                <p>{p.text}</p>
              </Reveal>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
