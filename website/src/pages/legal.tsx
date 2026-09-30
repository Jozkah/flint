import { Callout, DocPage, Ext, Table, type Sec } from '../components/Doc'
import { LINKS, pageHref } from '../lib/site'

const UPDATED = '30 September 2026'

export function Privacy() {
  const sections: Sec[] = [
    {
      id: 'summary',
      title: 'Summary',
      body: (
        <>
          <ul>
            <li>This website sets no cookies, stores nothing in your browser, runs no analytics and loads no third-party scripts, fonts or trackers.</li>
            <li>The Flint app has no telemetry, no analytics and no update checks. It does not discover or download models in the background, and it reaches the network only for features you use: Hugging Face Discover, a cloud provider, a remote MCP server, or web search.</li>
            <li>Your chats, files, memory and settings stay on your computer. Provider keys are kept in your operating system’s keyring.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'website',
      title: 'This website',
      body: (
        <>
          <p>The site is a set of static pages served by GitHub Pages. It has no accounts, no forms and no server of its own, so the Flint maintainers do not collect or receive any personal data from visitors.</p>
          <p>
            Like any web host, GitHub receives technical request data when a page loads, such as your IP address and browser details, and handles it under <Ext href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement">GitHub’s privacy statement</Ext>. The same applies when you follow a link to GitHub, for example to download an installer or open the repository.
          </p>
          <p>Fonts and images are served from the same site. The download buttons choose a platform using your browser’s own platform information, locally in your browser. Nothing about it is sent anywhere.</p>
        </>
      ),
    },
    {
      id: 'app-local',
      title: 'What stays on your computer',
      body: (
        <>
          <p>Flint is local-first by design. On your machine, Flint keeps:</p>
          <ul>
            <li>conversations, Cowork sessions, Discussion Rooms and their run records;</li>
            <li>files you attach and the copies Flint works on in managed worktrees;</li>
            <li>memory, settings, permission grants and usage figures;</li>
            <li>provider API keys and MCP sign-in tokens, stored through the operating system’s keyring.</li>
          </ul>
          <p>The build has no telemetry, analytics or automatic update checks, and it does not discover or download models in the background. Models come from files you import, or from Hugging Face Discover when you use it. A diagnostic bundle, if you create one, is redacted, shown to you first and never uploaded by Flint.</p>
          <p>You can see what left your machine. The request log shows what each model was sent and where every request went, and “What Flint is using” shows what applied to each reply.</p>
        </>
      ),
    },
    {
      id: 'leaves',
      title: 'When data leaves your computer',
      body: (
        <>
          <p>Data leaves only through something you set up or approved:</p>
          <Table
            label="Features that send data off your computer"
            head={['Feature', 'What is sent', 'Where']}
            rows={[
              ['A cloud model provider', 'Your messages, included files and tool results for that conversation', 'The provider you added, under your own key and their terms'],
              ['A server on your network', 'The same, for a self-hosted or LAN endpoint you point Flint at', 'That server'],
              ['Remote MCP servers', 'The tool calls and arguments you allow for that server', 'The server you connected'],
              ['Hugging Face Discover', 'Your searches and requests for model details, and the model files you choose to download', 'Hugging Face'],
              ['Web search', 'The search queries Flint makes when you turn the feature on', 'The search service configured for it'],
              ['Git and GitHub commands', 'Whatever the approved command sends, such as a push', 'The remote the command targets'],
              ['Remote access (preview)', 'Chat, Cowork and Rooms traffic between your phone and your desktop over Tailscale, your LAN or loopback', 'Your own devices. Models, keys and files stay on the desktop'],
            ]}
          />
          <p>Local models run through the bundled llama.cpp engine or MLX on your device and need no network. Once you use a remote provider, its handling of your data is governed by that provider’s terms and privacy policy, not by this one.</p>
        </>
      ),
    },
    {
      id: 'controls',
      title: 'Your controls',
      body: (
        <ul>
          <li>Approve or deny each action. “Allow once” is never saved, and every standing grant appears on the Permissions page with a Revoke button.</li>
          <li>Remove a provider key, disable a provider, or turn off web search at any time.</li>
          <li>Review what Flint proposes to remember before it is saved. Forgetting a memory also removes the saved requests that used it.</li>
          <li>Choose a custom data folder, and delete your data by removing that folder. Your data is yours to copy, move or delete.</li>
        </ul>
      ),
    },
    {
      id: 'jan',
      title: 'Migrating from Jan',
      body: <p>If you used Jan, Flint can copy, reuse or move your existing data on first launch. This happens entirely on your computer, and you choose which categories to bring.</p>,
    },
    {
      id: 'changes',
      title: 'Changes to this policy',
      body: (
        <p>
          This page is maintained in the same repository as the code, so every change is visible in its <Ext href={`${LINKS.src}/legal.tsx`}>public history</Ext>. If Flint or this site starts collecting data it does not collect today, this page will change before the software does.
        </p>
      ),
    },
    {
      id: 'contact',
      title: 'Questions',
      body: (
        <p>
          Ask in a <Ext href={LINKS.issues}>public issue</Ext>. For a vulnerability, follow the <a href={pageHref('security-policy')}>security policy</a> instead of opening an issue.
        </p>
      ),
    },
  ]
  return (
    <DocPage
      eyebrow="Legal"
      title="Privacy policy"
      lede="What this website and the Flint app do with your data. Short version: very little leaves your computer, and only when you choose."
      updated={UPDATED}
      source="legal.tsx"
      sections={sections}
    />
  )
}

export function Terms() {
  const sections: Sec[] = [
    {
      id: 'scope',
      title: 'What these terms cover',
      body: (
        <>
          <p>
            Flint is open source software. The software itself is licensed under the <a href={pageHref('license')}>Apache License 2.0</a>, and that license, not this page, sets your rights to use, copy, modify and distribute it. These terms describe how you may use this website and set out a few plain-language expectations around using the software.
          </p>
        </>
      ),
    },
    {
      id: 'license',
      title: 'The software license',
      body: (
        <>
          <p>
            Copyright 2026 Jozkah. Flint is a modified fork of <Ext href={LINKS.jan}>Jan</Ext> (copyright 2025 Menlo Research, also Apache License 2.0). The full text is in the <Ext href={LINKS.license}>LICENSE</Ext> file.
          </p>
          <p>Under that license the software is provided “as is”, without warranties or conditions of any kind, and the authors are not liable for damages arising from its use. Sections 7 and 8 of the license are the binding wording.</p>
        </>
      ),
    },
    {
      id: 'responsibility',
      title: 'Your responsibility when using AI and agents',
      body: (
        <>
          <p>Models make mistakes, and an agent that can edit files and run commands can make costly ones. Flint is built to keep you informed and in control, but you remain responsible for what you run and approve.</p>
          <ul>
            <li>Read approval prompts and diffs before you allow anything. Wider grants such as “Always allow” are labelled Broader for a reason.</li>
            <li>Keep backups or version control for anything you care about. Flint’s worktrees, checkpoints and review step reduce risk, and do not remove it.</li>
            <li>Treat model output as a draft. Flint reports which checks actually ran, and that does not make a change correct.</li>
            <li>The operating system sandbox limits what shell commands can reach. It is a safeguard, not a guarantee.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'third-parties',
      title: 'Models, providers and servers you connect',
      body: <p>When you add a cloud provider, MCP server or search service, you use it under your own account and its own terms. You are responsible for those terms, for any charges, and for what you choose to send. Do not use Flint to break the law or a provider’s rules.</p>,
    },
    {
      id: 'website',
      title: 'This website',
      body: (
        <>
          <p>The site is informational and provided as is. Descriptions reflect the software at the time of writing and may lag behind a release. The repository and <Ext href={LINKS.features}>feature list</Ext> are the authority on what Flint does.</p>
          <p>Screenshots are real captures of Flint using an invented example project and made-up data. Product and provider names shown in them belong to their owners, and their appearance does not imply endorsement.</p>
        </>
      ),
    },
    {
      id: 'contributions',
      title: 'Contributions',
      body: (
        <p>
          Unless you state otherwise, a contribution you submit to Flint is licensed under the same Apache License 2.0, as Section 5 of that license provides. See <Ext href={LINKS.contributing}>CONTRIBUTING</Ext> for how to take part.
        </p>
      ),
    },
    {
      id: 'changes',
      title: 'Changes and questions',
      body: (
        <p>
          These terms may change, and the history is public in <Ext href={`${LINKS.src}/legal.tsx`}>the repository</Ext>. Questions go to a <Ext href={LINKS.issues}>public issue</Ext>.
        </p>
      ),
    },
  ]
  return (
    <DocPage
      eyebrow="Legal"
      title="Terms of use"
      lede="Plain-language terms for this website and for using Flint. The software license is the Apache License 2.0."
      updated={UPDATED}
      source="legal.tsx"
      sections={sections}
    />
  )
}

export function License() {
  const sections: Sec[] = [
    {
      id: 'flint',
      title: 'Flint’s license',
      body: (
        <>
          <p>
            Flint is licensed under the <Ext href="https://www.apache.org/licenses/LICENSE-2.0">Apache License, Version 2.0</Ext>, the same license as upstream Jan. Copyright 2026 Jozkah. The authoritative text is the <Ext href={LINKS.license}>LICENSE</Ext> file in the repository, and this page is only a summary.
          </p>
        </>
      ),
    },
    {
      id: 'summary',
      title: 'What it means, in short',
      body: (
        <>
          <h3>You may</h3>
          <ul>
            <li>use Flint for any purpose, including commercial use;</li>
            <li>modify it and distribute your modified version;</li>
            <li>rely on the patent license granted by contributors for their contributions.</li>
          </ul>
          <h3>You must</h3>
          <ul>
            <li>include a copy of the license and the NOTICE file when you redistribute;</li>
            <li>mark files you changed;</li>
            <li>keep the existing copyright and attribution notices.</li>
          </ul>
          <h3>You may not</h3>
          <ul>
            <li>use the names or trademarks of the authors except to describe where the software comes from;</li>
            <li>hold the authors liable. The software comes without warranty.</li>
          </ul>
          <Callout>This summary is not legal advice. If the license matters for your use, read the full text.</Callout>
        </>
      ),
    },
    {
      id: 'jan',
      title: 'Built on Jan',
      body: (
        <>
          <p>
            Flint is an independent fork of <Ext href={LINKS.jan}>Jan</Ext>. Jan is copyright 2025 Menlo Research and licensed under the Apache License 2.0. Files that came from Jan have been modified by the Flint authors, and the upstream copyright and attribution notices are kept in the LICENSE file and throughout the source.
          </p>
          <p>Jan’s notice asks for attribution in user-facing documentation and materials where appropriate. This page, the footer of every page, and the README give it.</p>
        </>
      ),
    },
    {
      id: 'others',
      title: 'Other projects Flint builds on',
      body: (
        <>
          <p>Each of these keeps its own license, and you can read it in its repository.</p>
          <ul>
            <li>
              <Ext href={LINKS.llamacpp}>llama.cpp</Ext>, the engine behind local GGUF models.
            </li>
            <li>
              <Ext href={LINKS.tauri}>Tauri</Ext>, the desktop application framework.
            </li>
            <li>
              <Ext href={LINKS.scalar}>Scalar</Ext>, used for API documentation.
            </li>
            <li>
              <Ext href={LINKS.inter}>Inter</Ext>, the typeface used in Flint and on this site, distributed under the SIL Open Font License.
            </li>
          </ul>
          <p>
            The full list of dependencies and their licenses is in the repository’s package manifests. Model files you import, and the providers you connect, have their own licenses and terms, which you are responsible for.
          </p>
        </>
      ),
    },
    {
      id: 'notice',
      title: 'NOTICE',
      body: (
        <pre className="code">
          {`Flint
Copyright 2026 Jozkah

This product is a modified fork of Jan (https://github.com/janhq/jan).
Jan: Copyright 2025 Menlo Research. Licensed under the Apache License, Version 2.0.
Files originating from Jan have been modified by the Flint authors.`}
        </pre>
      ),
    },
  ]
  return <DocPage eyebrow="Legal" title="License and attribution" lede="Flint is open source under the Apache License 2.0, and it builds on Jan and other open projects." updated={UPDATED} source="legal.tsx" sections={sections} />
}

export function SecurityPolicy() {
  const sections: Sec[] = [
    {
      id: 'report',
      title: 'Report a vulnerability',
      body: (
        <>
          <p>Please do not open a public issue for security problems. Report them privately through GitHub’s private vulnerability reporting.</p>
          <ol>
            <li>
              Open the <Ext href={LINKS.advisory}>private report form</Ext>, or go to the repository’s Security tab and choose Report a vulnerability.
            </li>
            <li>Describe the issue, the affected version and platform, and the steps to reproduce it. A minimal proof of concept helps.</li>
          </ol>
          <p>You will get a reply in the advisory thread. Once a fix is available, the advisory is published with credit to you unless you ask to stay anonymous.</p>
        </>
      ),
    },
    {
      id: 'versions',
      title: 'Supported versions',
      body: (
        <>
          <Table label="Supported versions" head={['Version', 'Supported']} rows={[['0.9.x', 'Yes'], ['Earlier than 0.9', 'No']]} />
          <p>Security fixes land on the main branch and ship in the next 0.9.x release.</p>
        </>
      ),
    },
    {
      id: 'scope',
      title: 'What is in scope',
      body: (
        <>
          <p>Flint runs models and agent tools on your own machine. Reports are especially welcome for:</p>
          <ul>
            <li>ways an agent or tool call can escape the configured permissions or sandbox;</li>
            <li>ways a model, MCP server, extension or downloaded file can run code or read files without the user’s approval;</li>
            <li>leaks of API keys or other secrets stored by the app.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'model',
      title: 'How Flint protects you',
      body: (
        <>
          <p>A summary of the safeguards described in the feature list. None of them is a substitute for reading what you approve.</p>
          <ul>
            <li>
              <b>Approvals.</b> Commands and writes you have not allowed stop and wait. “Allow once” is never saved, and every standing grant can be revoked.
            </li>
            <li>
              <b>Sandbox.</b> Shell commands run inside bubblewrap on Linux, Seatbelt on macOS and AppContainer on Windows.
            </li>
            <li>
              <b>Review.</b> Changes are shown as diffs first. Cowork can work in a managed Git worktree so nothing reaches your folder until you apply it, and dependency, lock file and migration changes need explicit acknowledgement.
            </li>
            <li>
              <b>Secrets.</b> Provider keys and sign-in tokens live in the OS keyring. Protected secret files are redacted from logs and transcripts, and a secret scan blocks diffs that contain credentials.
            </li>
            <li>
              <b>Trust is tied to configuration.</b> If an MCP server’s configuration changes, the earlier approval stops applying and Flint says why.
            </li>
          </ul>
          <p>
            More in the <a href={pageHref('privacy')}>privacy policy</a> and the <Ext href={LINKS.features}>feature list</Ext>.
          </p>
        </>
      ),
    },
    {
      id: 'source',
      title: 'The canonical policy',
      body: (
        <p>
          This page mirrors <Ext href={LINKS.securityPolicy}>SECURITY.md</Ext> in the repository. If the two ever differ, the file in the repository wins.
        </p>
      ),
    },
  ]
  return <DocPage eyebrow="Legal" title="Security policy" lede="How to report a vulnerability in Flint, and what to expect." source="legal.tsx" sections={sections} />
}

export function Accessibility() {
  const sections: Sec[] = [
    {
      id: 'app',
      title: 'The Flint app',
      body: (
        <>
          <p>What the desktop app does today, as listed in the feature documentation:</p>
          <ul>
            <li>Agent screens have screen-reader roles, labels and announcements.</li>
            <li>They work fully from the keyboard, and focus rings stay visible.</li>
            <li>Every shortcut can be rebound, and conflicts are refused.</li>
            <li>Below 1024 px wide, navigation moves into a sheet. On phones, dialogs become bottom sheets and touch targets are at least 44 px.</li>
            <li>Flint ships light and dark themes, and Flint follows a Reduce motion setting.</li>
          </ul>
          <Callout tone="warn" title="Known gap">
            A full screen-reader pass of the app has not been done yet.
          </Callout>
        </>
      ),
    },
    {
      id: 'site',
      title: 'This website',
      body: (
        <>
          <ul>
            <li>Pages use semantic landmarks and a single, ordered heading outline, with a skip link at the top.</li>
            <li>Everything is reachable and usable with a keyboard, with visible focus states. The screenshot viewer is a native dialog: Esc closes it and the arrow keys move between images.</li>
            <li>Screenshots have text descriptions. Decorative marks are hidden from assistive technology.</li>
            <li>Animation is optional. With your system’s reduced-motion setting on, it is turned off and content is shown at once. The pages also work without JavaScript.</li>
            <li>Text and controls use high-contrast colors on the dark theme.</li>
          </ul>
          <Callout tone="warn" title="Not yet audited">
            The site has been checked with automated tests and in several browsers, and has not had a formal audit or testing with a range of assistive technologies.
          </Callout>
        </>
      ),
    },
    {
      id: 'feedback',
      title: 'Tell us about a barrier',
      body: (
        <p>
          If something in the app or on this site is hard to use, please open an <Ext href={LINKS.issues}>issue</Ext> and describe the page or screen, what you use to browse, and what went wrong. Accessibility fixes are treated as bugs.
        </p>
      ),
    },
  ]
  return <DocPage eyebrow="Legal" title="Accessibility" lede="What works today, and what has not been checked yet." updated={UPDATED} source="legal.tsx" sections={sections} />
}
