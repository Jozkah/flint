import { useEffect, useState, type KeyboardEvent } from 'react'
import { ExternalLink, FlintMark, Icon, Reveal, DownloadButton, useOS } from './ui'
import { asset, LINKS, mb, OS_LABEL, pageHref, RELEASE, sectionHref, type OS } from '../lib/site'

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
              Installers for Windows, macOS and Linux are attached to each release. Flint is free and open source.
            </p>
            <p className="dim" style={{ fontSize: 14, marginTop: 18 }}>
              {RELEASE.tag ? (
                <>
                  Latest release: <ExternalLink href={RELEASE.url} className="link">{RELEASE.tag}</ExternalLink>
                </>
              ) : (
                <ExternalLink href={LINKS.latest} className="link">Open the latest release</ExternalLink>
              )}{' '}
              · <ExternalLink href={LINKS.build} className="link">Build from source</ExternalLink> · <a href={pageHref('install')} className="link">Install guide</a>
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
                  <b>You choose your models.</b> Import a GGUF file you already have, search Hugging Face in Discover and download the one you pick, use an MLX model on Apple silicon, or add a cloud provider with your own key. Nothing is discovered or downloaded in the background.
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
          <p className="lede">A local-first AI workspace for real work.</p>
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

type FLink = [label: string, href: string, external?: boolean]
const cols = (home: boolean): Array<[string, FLink[]]> => [
  ['Product', [['Chat', sectionHref('product', home)], ['Cowork', sectionHref('cowork', home)], ['Discussion Rooms', sectionHref('rooms', home)], ['Models', sectionHref('models', home)], ['Security', sectionHref('security', home)]]],
  ['Resources', [['Docs', pageHref('docs')], ['Install guide', pageHref('install')], ['FAQ', pageHref('faq')], ['Changelog', pageHref('changelog')], ['Releases', LINKS.releases, true], ['Build from source', LINKS.build, true]]],
  ['Legal', [['Privacy', pageHref('privacy')], ['Terms', pageHref('terms')], ['License and attribution', pageHref('license')], ['Security policy', pageHref('security-policy')], ['Accessibility', pageHref('accessibility')]]],
  ['Open source', [['GitHub', LINKS.repo, true], ['Apache 2.0', LINKS.license, true], ['Contribute', LINKS.contributing, true], ['Report an issue', LINKS.issues, true], ['Brand assets', pageHref('brand')]]],
]

export function Footer({ home }: { home: boolean }) {
  return (
    <footer className="footer">
      <div className="wrap-wide">
        <div className="fgrid">
          <div className="fbrand">
            <a href={home ? '#top' : pageHref('')} className="brand">
              <img src={asset('brand/icon-64.png')} width="30" height="30" alt="" />
              Flint
            </a>
            <p>A local-first AI workspace for your desktop.</p>
          </div>
          {cols(home).map(([h, links]) => (
            <nav key={h} aria-label={h}>
              <h2>{h}</h2>
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
          <span>
            Licensed under the Apache License 2.0. <a href={pageHref('license')} className="link">Details</a>
          </span>
        </div>
      </div>
    </footer>
  )
}
