import { Callout, DocPage, Ext, Table, type Sec } from '../components/Doc'
import { ExternalLink, Icon } from '../components/ui'
import { LINKS, mb, OS_LABEL, pageHref, RELEASE, asset, type OS } from '../lib/site'
import changelog from '../generated/changelog.json'

const doc = (p: string) => `${LINKS.repo}/blob/main/${p}`
const agentDoc = (n: string) => doc(`docs/src/pages/docs/agent/${n}.mdx`)

function Card({ href, title, children, external = true }: { href: string; title: string; children: React.ReactNode; external?: boolean }) {
  const inner = (
    <>
      <span className="card-t">
        {title}
        <span aria-hidden="true">{Icon.arrow}</span>
      </span>
      <span className="card-d">{children}</span>
    </>
  )
  return external ? (
    <ExternalLink href={href} className="dcard tilt">
      {inner}
    </ExternalLink>
  ) : (
    <a href={href} className="dcard tilt">
      {inner}
    </a>
  )
}

export function Docs() {
  return (
    <article className="doc">
      <header className="doc-head wrap-wide">
        <p className="eyebrow">
          <span className="dot" />
          Docs
        </p>
        <h1 className="doc-title">Documentation</h1>
        <p className="lede">Guides live next to the code, so they change with each release. Start here, then follow a link into the repository.</p>
      </header>
      <div className="wrap-wide prose-wide">
        <h2 className="sr-only">Start</h2>
        <div className="dgrid">
          <Card href={pageHref('install')} title="Install guide" external={false}>
            Download, open an unsigned installer, bring your first model.
          </Card>
          <Card href={pageHref('faq')} title="FAQ" external={false}>
            Privacy, models, permissions and how Flint relates to Jan.
          </Card>
          <Card href={LINKS.readme} title="README">
            What Flint is, getting started and migrating from Jan.
          </Card>
          <Card href={LINKS.features} title="All features">
            The full list of what is implemented, and what is not finished yet.
          </Card>
        </div>
        <h2 className="doc-h2">Using the agent</h2>
        <div className="dgrid">
          <Card href={agentDoc('quickstart')} title="Quickstart">
            Run an agent from the command line.
          </Card>
          <Card href={agentDoc('run-modes')} title="Run modes">
            Auto, Ask before changes, and Review.
          </Card>
          <Card href={agentDoc('permissions')} title="Tool permissions">
            Rules, scopes and revoking grants.
          </Card>
          <Card href={agentDoc('sessions')} title="Sessions">
            Resume, fork, export and import a session.
          </Card>
          <Card href={agentDoc('subagents')} title="Subagents">
            Parallel agents and the built-in roles.
          </Card>
          <Card href={agentDoc('memory')} title="Memory">
            Project, session and user memory.
          </Card>
        </div>
        <h2 className="doc-h2">Extending Flint</h2>
        <div className="dgrid">
          <Card href={agentDoc('mcp')} title="MCP servers">
            Connect tools, with trust tied to configuration.
          </Card>
          <Card href={agentDoc('skills')} title="Skills and plugins">
            Package instructions and tools for reuse.
          </Card>
          <Card href={agentDoc('providers')} title="Providers">
            Local engines and OpenAI- or Anthropic-compatible endpoints.
          </Card>
          <Card href={agentDoc('sdk')} title="Agent SDK">
            Embed the agent from JavaScript or Python.
          </Card>
          <Card href={doc('docs/HOOKS.md')} title="Hooks">
            Run sandboxed lifecycle hooks.
          </Card>
          <Card href={doc('docs/CONTEXT_COMPACTION.md')} title="Context compaction">
            How long conversations stay within a model’s window.
          </Card>
        </div>
        <h2 className="doc-h2">Build and contribute</h2>
        <div className="dgrid">
          <Card href={LINKS.build} title="Build from source">
            Toolchain, installers, the local engine and troubleshooting.
          </Card>
          <Card href={LINKS.contributing} title="Contributing">
            Repository layout and how to send a change.
          </Card>
          <Card href={LINKS.issues} title="Issues">
            Report a bug or ask a question.
          </Card>
          <Card href={pageHref('security-policy')} title="Security policy" external={false}>
            Report a vulnerability privately.
          </Card>
        </div>
        <Callout title="A note on names">Some agent guides still say “Jan Agent” because Flint began as a fork of Jan. They describe Flint’s agent.</Callout>
      </div>
    </article>
  )
}

const OSES: OS[] = ['windows', 'macos', 'linux']

export function Install() {
  const sections: Sec[] = [
    {
      id: 'download',
      title: 'Download',
      body: (
        <>
          <p>
            Installers for Windows, macOS and Linux are attached to each release.
            {RELEASE.tag ? (
              <>
                {' '}
                The latest is <Ext href={RELEASE.url}>{RELEASE.tag}</Ext>.
              </>
            ) : null}
          </p>
          <Table
            label="Installers"
            head={['System', 'File', 'Size']}
            rows={
              OSES.flatMap((o) => RELEASE.assets[o].map((f) => [OS_LABEL[o], <Ext key={f.name} href={f.url}>{f.label}</Ext>, mb(f.size)])).length
                ? OSES.flatMap((o) => RELEASE.assets[o].map((f) => [OS_LABEL[o], <Ext key={f.name} href={f.url}>{f.label}</Ext>, mb(f.size)]))
                : [['All', <Ext key="r" href={LINKS.latest}>Open the latest release</Ext>, '']]
            }
          />
          <p>
            If a release has no installer for your system yet, <Ext href={LINKS.build}>build Flint from source</Ext>.
          </p>
        </>
      ),
    },
    {
      id: 'unsigned',
      title: 'Opening an unsigned installer',
      body: (
        <>
          <p>The installers are not code-signed, so your system warns you the first time you open Flint.</p>
          <h3>Windows</h3>
          <p>
            SmartScreen shows “Windows protected your PC”. Click <b>More info</b>, then <b>Run anyway</b>.
          </p>
          <h3>macOS</h3>
          <p>
            Right-click (or Control-click) Flint in Applications and choose <b>Open</b>, then <b>Open</b> again. Alternatively, try to open it once, then go to System Settings → Privacy &amp; Security and click <b>Open Anyway</b>.
          </p>
          <Callout>Local models on macOS need Apple silicon (M1 or later). On Intel Macs you can still use cloud providers.</Callout>
          <h3>Linux</h3>
          <p>The release has an AppImage and a .deb. Choose the one that fits your distribution.</p>
        </>
      ),
    },
    {
      id: 'models',
      title: 'Bring your models',
      body: (
        <>
          <p>Open Discover to search Hugging Face and choose the exact GGUF quantization, or the MLX repository on Apple silicon, that you want. Downloads start only when you click Download, and they support pause and resume. You can still import a GGUF file you already have (Models → llama.cpp → Import), or add a cloud provider with your own key.</p>
          <p>The Models page separates what was measured on your device from what is only estimated. An estimate never stops you from trying a model.</p>
        </>
      ),
    },
    {
      id: 'first-run',
      title: 'Your first run',
      body: (
        <ol>
          <li>
            <b>Open Flint.</b> A short first-run guide asks what you want to do and explains local versus cloud processing. You can skip it and reopen it from Settings → General.
          </li>
          <li>
            <b>Choose a model</b> in Models.
          </li>
          <li>
            <b>Start a chat.</b> Attach files with +, and open What Flint is using in the header to see what applies to the conversation.
          </li>
          <li>
            <b>Use Cowork for file work.</b> Attach a project folder or work in the sandbox, then describe the task. Flint asks before any change or command you have not allowed.
          </li>
          <li>
            <b>Review the result.</b> The run summary says what happened and what is unresolved. The Changes panel shows real diffs, and checkpoints restore earlier states.
          </li>
        </ol>
      ),
    },
    {
      id: 'jan',
      title: 'Coming from Jan',
      body: (
        <>
          <p>Flint keeps Jan’s bundle identifier and data path, so it detects an existing Jan install. On first launch you can copy your Jan data into Flint, reuse it in place, move it (a backup is kept), or start fresh, and you choose which categories to bring.</p>
          <p>A newer Flint item is never silently overwritten and a failed migration rolls back. You can run the assistant again later from Settings → General → Migrate from JAN.</p>
        </>
      ),
    },
    {
      id: 'source',
      title: 'Build from source',
      body: (
        <p>
          You need Git, Node 20+, Rust, and CMake and LLVM on Windows. The first build needs about 30 GB of disk space. The <Ext href={LINKS.build}>build guide</Ext> covers each operating system, installers and troubleshooting.
        </p>
      ),
    },
  ]
  return <DocPage eyebrow="Install" title="Install Flint" lede="Download an installer, open it past the unsigned-app warning, and bring your first model." sections={sections} />
}

export function Faq() {
  const q = (question: string, a: React.ReactNode) => (
    <details>
      <summary>{question}</summary>
      <div className="ans">{a}</div>
    </details>
  )
  const sections: Sec[] = [
    {
      id: 'basics',
      title: 'The basics',
      body: (
        <>
          {q('What is Flint?', <p>A local-first AI workspace for your desktop. You can chat with local or remote models, hand real work to a Cowork agent, and put several models in one Discussion Room. It runs on Windows, macOS and Linux.</p>)}
          {q('Is Flint free?', <p>Yes. It is open source under the Apache License 2.0, and you can read, build and change the code.</p>)}
          {q('How is Flint related to Jan?', <p>Flint is an independent fork of Jan with its own design and features. It keeps Jan’s attribution and can migrate your existing Jan data.</p>)}
          {q('Does Flint have a command line?', <p>Yes. There is a command line for headless agent runs, with a JSON-lines API and background jobs, and there are JavaScript and Python SDKs. See the <a href={pageHref('docs')}>docs</a>.</p>)}
        </>
      ),
    },
    {
      id: 'privacy',
      title: 'Privacy and data',
      body: (
        <>
          {q('Does Flint send my data anywhere?', <p>Not by itself. There is no telemetry, analytics or update check. Flint does not discover or download models in the background. It reaches the network only for features you use: Hugging Face Discover, a cloud provider key, a remote MCP server, or turn on web search. See the <a href={pageHref('privacy')}>privacy policy</a>.</p>)}
          {q('Can I use it offline?', <p>Yes, with local models. GGUF models run through the bundled llama.cpp engine, and MLX models run on Apple silicon, both on your device. Cloud providers need a network connection.</p>)}
          {q('Where are my API keys stored?', <p>In your operating system’s keyring.</p>)}
          {q('Where is my data kept?', <p>On your computer, in Flint’s data folder. You can choose a custom data folder. Flint keeps Jan’s data path so an existing install is detected.</p>)}
        </>
      ),
    },
    {
      id: 'models',
      title: 'Models',
      body: (
        <>
          {q('Which models can I use?', <p>GGUF models through the bundled llama.cpp engine, MLX models on Apple silicon, and any OpenAI-compatible or Anthropic-compatible provider with your own key, including a server on your network.</p>)}
          {q('Does Flint download models for me?', <p>Only when you ask. Open Discover to search Hugging Face and pick a GGUF quantization or an MLX repository, and the download starts when you click Download. Flint does not discover or download models in the background. You can also import files you already have, or connect a provider.</p>)}
          {q('Do local models work on Intel Macs?', <p>No. Local models on macOS need Apple silicon (M1 or later). Intel Macs can still use cloud providers.</p>)}
        </>
      ),
    },
    {
      id: 'agents',
      title: 'Cowork and permissions',
      body: (
        <>
          {q('What is the difference between Chat and Cowork?', <p>Chat is for questions, writing and documents. Cowork is for tasks that touch files: an agent reads, writes and runs commands in a sandbox or a managed copy of your project, asks before anything you have not allowed, and ends each run with a plain summary.</p>)}
          {q('Can the agent change my files without asking?', <p>Only in ways you have allowed. Run modes are Auto, Ask before changes and Review, and a repository starts in Review. Flint shows a diff before writes and can work in a managed Git worktree, so nothing reaches your folder until you apply it.</p>)}
          {q('What do the approval options mean?', <p>“Allow once” covers only that request and is never saved. “Allow in this conversation” covers that tool in that conversation until you revoke it. “Always allow” applies in every conversation until you revoke it. Every standing grant is listed on the Permissions page.</p>)}
          {q('Does the run summary just repeat what the model said?', <p>No. It is recorded by Flint. Only real test, build and lint commands count as checks, and anything the model merely claims is labelled as not verified by Flint.</p>)}
          {q('Can I use Flint from my phone?', <p>There is a remote access preview. You pair a phone over Tailscale, your LAN or loopback and use Chat, Cowork and Rooms, while models, keys and files stay on the desktop.</p>)}
        </>
      ),
    },
    {
      id: 'install',
      title: 'Installing',
      body: (
        <>
          {q('Why does my system warn me when I open Flint?', <p>The installers are not code-signed, so Windows and macOS show a warning the first time. The <a href={pageHref('install')}>install guide</a> has the steps for each system.</p>)}
          {q('How do I build it myself?', <p>
            Follow the <Ext href={LINKS.build}>build guide</Ext>. Expect to need about 30 GB of disk space for the first build.
          </p>)}
        </>
      ),
    },
    {
      id: 'help',
      title: 'Help and contributing',
      body: (
        <>
          {q('How do I report a bug?', <p>Open an <Ext href={LINKS.issues}>issue</Ext>. Screenshots help.</p>)}
          {q('How do I report a security problem?', <p>Privately, through the <a href={pageHref('security-policy')}>security policy</a>. Please do not open a public issue.</p>)}
          {q('Can I contribute?', <p>Yes. See <Ext href={LINKS.contributing}>CONTRIBUTING</Ext>.</p>)}
        </>
      ),
    },
  ]
  return <DocPage eyebrow="FAQ" title="Frequently asked questions" lede="Short answers, each based on what the software does today." sections={sections} />
}

export function Changelog() {
  const c = changelog
  const sections: Sec[] = [
    {
      id: 'highlights',
      title: 'Highlights',
      body: (
        <dl className="defs">
          {c.highlights.map((h) => (
            <div key={h.title}>
              <dt>{h.title}</dt>
              <dd>{h.text}</dd>
            </div>
          ))}
        </dl>
      ),
    },
    ...(c.finals.length
      ? [
          {
            id: 'more',
            title: 'Also in this release',
            body: (
              <>
                <p>Late additions, each described in full in the changelog:</p>
                <ul>
                  {c.finals.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </>
            ),
          } satisfies Sec,
        ]
      : []),
    {
      id: 'full',
      title: 'The full changelog',
      body: (
        <p>
          This page is built from the repository’s <Ext href={LINKS.changelog}>CHANGELOG.md</Ext>, which lists every shipped feature and change. Installers and release notes are on the <Ext href={LINKS.releases}>releases page</Ext>.
        </p>
      ),
    },
  ]
  return <DocPage eyebrow="Changelog" title={c.title} lede={c.intro} sections={sections} />
}

const SWATCHES: Array<[string, string, string]> = [
  ['Background', '#0A0B0D', 'The page and app ground'],
  ['Card', '#131519', 'Panels and frames'],
  ['Border', '#23262C', 'Thin dividers'],
  ['Foreground', '#E6E8EB', 'Text and the primary action'],
  ['Muted', '#8A909A', 'Secondary text'],
  ['Warning', '#FBBF24', 'Approvals only'],
]

export function Brand() {
  const sizes = [64, 128, 256, 512]
  const sections: Sec[] = [
    {
      id: 'icon',
      title: 'The Flint icon',
      body: (
        <>
          <p>The mark is the application icon itself, a pixel-art flint stone. Use it exactly as it is.</p>
          <div className="brand-grid">
            {sizes.map((s) => (
              <a key={s} className="brand-tile" href={asset(`brand/icon-${s}.png`)} download={`flint-icon-${s}.png`}>
                <span className="brand-img">
                  <img src={asset(`brand/icon-${s}.png`)} width={Math.min(s, 128)} height={Math.min(s, 128)} alt={`Flint icon, ${s} pixels`} loading="lazy" />
                </span>
                <span>
                  PNG, {s} × {s}
                </span>
              </a>
            ))}
          </div>
          <p className="dim">Transparent background, trimmed to the mark. The original is src-tauri/icons/icon.png in the repository.</p>
        </>
      ),
    },
    {
      id: 'use',
      title: 'Using the name and icon',
      body: (
        <ul>
          <li>Write the name as “Flint”.</li>
          <li>Do not redraw, recolor, stretch, rotate or add effects to the icon. It reads best on the dark background Flint uses.</li>
          <li>Say where it comes from. Flint is an independent fork of Jan, so do not present it as Jan or as made by Jan’s authors.</li>
          <li>
            The <a href={pageHref('license')}>license</a> covers the software. It does not grant rights to the authors’ names or trademarks beyond describing where the software comes from.
          </li>
        </ul>
      ),
    },
    {
      id: 'color',
      title: 'Color',
      body: (
        <>
          <p>Flint’s interface is graphite with a near-white primary action. Amber is reserved for things that wait on you.</p>
          <ul className="swatches">
            {SWATCHES.map(([n, hex, d]) => (
              <li key={n}>
                <span className="sw-chip" style={{ background: hex }} aria-hidden="true" />
                <span>
                  <b>{n}</b> <code>{hex}</code>
                  <br />
                  <span className="dim">{d}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ),
    },
    {
      id: 'type',
      title: 'Typography',
      body: (
        <p>
          Flint uses <Ext href={LINKS.inter}>Inter</Ext>, with the system monospace font for code.
        </p>
      ),
    },
    {
      id: 'screenshots',
      title: 'Screenshots',
      body: (
        <>
          <p>
            Product screenshots are real captures of Flint, kept in the repository at <Ext href={LINKS.shots}>docs/screenshots</Ext> at 3200 × 2000. They use an invented example project and made-up data, so you can publish them as they are.
          </p>
          <p>Crop and frame them as you like, but please do not edit the interface or its text, or show a recreated interface as if it were Flint.</p>
        </>
      ),
    },
  ]
  return <DocPage eyebrow="Brand" title="Brand assets" lede="The icon, colors and screenshots, and how to use them." sections={sections} />
}

export function NotFound() {
  return (
    <article className="doc">
      <header className="doc-head wrap-wide" style={{ paddingBottom: 'clamp(72px, 10vw, 160px)' }}>
        <p className="eyebrow">
          <span className="dot" />
          404
        </p>
        <h1 className="doc-title">This page is not here.</h1>
        <p className="lede">The link may be old, or mistyped. These pages exist:</p>
        <ul className="nf-links">
          <li>
            <a href={pageHref('')}>Home</a>
          </li>
          <li>
            <a href={pageHref('docs')}>Docs</a>
          </li>
          <li>
            <a href={pageHref('install')}>Install guide</a>
          </li>
          <li>
            <a href={pageHref('faq')}>FAQ</a>
          </li>
          <li>
            <ExternalLink href={LINKS.repo}>GitHub</ExternalLink>
          </li>
        </ul>
      </header>
    </article>
  )
}
