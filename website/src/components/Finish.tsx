import { useEffect, useState, type KeyboardEvent } from 'react'
import { ExternalLink, FlintMark, Icon, Reveal, DownloadButton, useOS } from './ui'
import { LINKS, mb, OS_LABEL, RELEASE, type OS } from '../lib/site'
import { asset } from '../lib/site'

const OSES: OS[] = ['windows', 'macos', 'linux']

export function Download() {
  const detected = useOS()
  const [os, setOs] = useState<OS>('windows')
  useEffect(() => {
    if (detected) setOs(detected)
  }, [detected])
  const files = RELEASE.assets[os]

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = OSES.indexOf(os)
    if (e.key === 'ArrowRight') setOs(OSES[(i + 1) % 3])
    if (e.key === 'ArrowLeft') setOs(OSES[(i + 2) % 3])
  }

  return (
    <section className="section" id="download" style={{ paddingTop: 0 }}>
      <div className="wrap-wide">
        <div className="split">
          <Reveal className="stack">
            <p className="eyebrow">
              <span className="dot" />
              Download
            </p>
            <h2 className="h2" style={{ marginTop: 16 }}>
              Install Flint.
            </h2>
            <p className="lede" style={{ marginTop: 22 }}>
              Installers for Windows, macOS and Linux are attached to each release. Flint is free and does not ask you to sign up.
            </p>
            <p className="dim" style={{ fontSize: 14, marginTop: 18 }}>
              {RELEASE.tag ? (
                <>
                  Latest release: <ExternalLink href={RELEASE.url} className="link">{RELEASE.tag}</ExternalLink>
                </>
              ) : (
                <ExternalLink href={LINKS.latest} className="link">Open the latest release</ExternalLink>
              )}{' '}
              · <ExternalLink href={LINKS.build} className="link">Build from source</ExternalLink>
            </p>
          </Reveal>
          <Reveal delay={100}>
            <div className="dl-card">
              <div className="dl-tabs" role="tablist" aria-label="Operating system" onKeyDown={onKey}>
                {OSES.map((o) => (
                  <button key={o} role="tab" id={`tab-${o}`} aria-selected={os === o} aria-controls="dl-panel" tabIndex={os === o ? 0 : -1} onClick={() => setOs(o)}>
                    {OS_LABEL[o]}
                    {detected === o && <span className="dim" style={{ marginLeft: 8, fontSize: 12 }}>your system</span>}
                  </button>
                ))}
              </div>
              <div className="dl-body" role="tabpanel" id="dl-panel" aria-labelledby={`tab-${os}`}>
                <div className="dl-files">
                  {files.length ? (
                    files.map((f, i) => (
                      <a key={f.name} className="dl-file" href={f.url} rel="noopener">
                        <span>
                          <b style={{ fontWeight: 600 }}>{f.label}</b>
                          <br />
                          <small>{f.name} · {mb(f.size)}</small>
                        </span>
                        <span className={i === 0 ? 'btn btn-sm btn-primary' : 'btn btn-sm'} aria-hidden="true">
                          {Icon.download}
                          Download
                        </span>
                      </a>
                    ))
                  ) : (
                    <a className="dl-file" href={LINKS.latest} target="_blank" rel="noopener noreferrer">
                      <span>
                        <b style={{ fontWeight: 600 }}>Open the latest release</b>
                        <br />
                        <small>Installers are attached on GitHub</small>
                      </span>
                      <span className="btn btn-sm btn-primary" aria-hidden="true">{Icon.arrow}Releases</span>
                    </a>
                  )}
                </div>
                <div className="note">
                  <b>The installers are not code-signed</b>, so your system warns you the first time you open Flint.
                  {os === 'windows' && (
                    <ol>
                      <li>SmartScreen shows “Windows protected your PC”.</li>
                      <li>Click <b>More info</b>, then <b>Run anyway</b>.</li>
                    </ol>
                  )}
                  {os === 'macos' && (
                    <>
                      <ol>
                        <li>Right-click (or Control-click) Flint in Applications and choose <b>Open</b>, then <b>Open</b> again.</li>
                        <li>Or try to open it once, then go to System Settings → Privacy &amp; Security and click <b>Open Anyway</b>.</li>
                      </ol>
                      <p style={{ marginTop: 10 }}>Local models need Apple silicon (M1 or later). On Intel Macs you can still use cloud providers.</p>
                    </>
                  )}
                  {os === 'linux' && <p style={{ marginTop: 8 }}>The AppImage and .deb come from the same release. Choose the one that fits your distribution.</p>}
                </div>
                <div className="note">
                  <b>You bring your own models.</b> Import a GGUF file you already have, use an MLX model on Apple silicon, or add a cloud provider with your own key. Flint does not download models for you.
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

export function FinalCta() {
  return (
    <section className="section final" aria-labelledby="final-h">
      <div className="wrap">
        <Reveal>
          <div className="mark">
            <div className="ember" aria-hidden="true">
              {[['30%', '0s', '5.6s', '-12px'], ['50%', '1.6s', '5s', '12px'], ['66%', '2.8s', '6s', '-4px']].map(([l, d, t, dx], i) => (
                <i key={i} style={{ ['--l' as string]: l, ['--d' as string]: d, ['--t' as string]: t, ['--dx' as string]: dx }} />
              ))}
            </div>
            <FlintMark size={256} />
          </div>
          <h2 className="h2" id="final-h">
            Your machine. Your models. Your rules.
          </h2>
          <p className="lede">A private, local-first AI workspace for real work.</p>
          <div className="hero-cta">
            <DownloadButton />
            <ExternalLink href={LINKS.build} className="btn">
              Build from source
            </ExternalLink>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

const COLS: Array<[string, Array<[string, string, boolean?]>]> = [
  ['Product', [['Chat', '#product'], ['Cowork', '#cowork'], ['Discussion Rooms', '#rooms'], ['Models', '#models'], ['Security', '#security']]],
  ['Resources', [['Docs', LINKS.docs, true], ['Releases', LINKS.releases, true], ['Build from source', LINKS.build, true], ['All features', LINKS.features, true]]],
  ['Open source', [['GitHub', LINKS.repo, true], ['Apache 2.0', LINKS.license, true], ['Contribute', LINKS.contributing, true], ['Report an issue', LINKS.issues, true]]],
]

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap-wide">
        <div className="fgrid">
          <div className="fbrand">
            <a href="#top" className="brand">
              <img src={asset('brand/icon-64.png')} width="30" height="30" alt="" />
              Flint
            </a>
            <p>A private, local-first AI workspace for your desktop.</p>
          </div>
          {COLS.map(([h, links]) => (
            <nav key={h} aria-label={h}>
              <h4>{h}</h4>
              <ul>
                {links.map(([label, href, ext]) => (
                  <li key={label}>
                    {ext ? (
                      <ExternalLink href={href}>{label}</ExternalLink>
                    ) : (
                      <a href={href}>{label}</a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="fbase">
          <span>
            Flint is an independent fork of <ExternalLink href={LINKS.jan} className="link">Jan</ExternalLink> and keeps upstream attribution.
          </span>
          <span>Licensed under the Apache License 2.0.</span>
        </div>
      </div>
    </footer>
  )
}
