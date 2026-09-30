import type { ComponentType } from 'react'
import { Home } from './Home'
import { Accessibility, License, Privacy, SecurityPolicy, Terms } from './legal'
import { Brand, Changelog, Docs, Faq, Install, NotFound } from './info'

export type PageDef = { path: string; title: string; description: string; Component: ComponentType }

/** Every prerendered page. `path` is relative to the site base; '' is the homepage. */
export const PAGES: PageDef[] = [
  { path: '', title: 'Flint: a local-first AI workspace for your desktop', description: 'Flint is an open source AI workspace for Windows, macOS and Linux. Chat with local or remote models, let Cowork agents work on real projects, and review every command, diff and decision before it reaches your files.', Component: Home },
  { path: 'docs', title: 'Documentation · Flint', description: 'Guides for installing Flint, using the Cowork agent, permissions, MCP, skills, providers, the SDK and building from source.', Component: Docs },
  { path: 'install', title: 'Install Flint', description: 'Download Flint for Windows, macOS or Linux, open the unsigned installer, bring your first model and migrate from Jan.', Component: Install },
  { path: 'faq', title: 'FAQ · Flint', description: 'Answers about Flint: privacy, local and remote models, Cowork permissions, installing, and how it relates to Jan.', Component: Faq },
  { path: 'changelog', title: 'Changelog · Flint', description: 'What shipped in the latest Flint release, built from the repository changelog.', Component: Changelog },
  { path: 'privacy', title: 'Privacy policy · Flint', description: 'What this website and the Flint app do with your data: no telemetry, no analytics, and network access only when you choose it.', Component: Privacy },
  { path: 'terms', title: 'Terms of use · Flint', description: 'Plain-language terms for this website and for using Flint. The software is licensed under the Apache License 2.0.', Component: Terms },
  { path: 'license', title: 'License and attribution · Flint', description: 'Flint is open source under the Apache License 2.0 and builds on Jan, llama.cpp, Tauri and other open projects.', Component: License },
  { path: 'security-policy', title: 'Security policy · Flint', description: 'How to report a vulnerability in Flint privately, which versions are supported, and what the safeguards are.', Component: SecurityPolicy },
  { path: 'accessibility', title: 'Accessibility · Flint', description: 'What works today in the Flint app and on this website for keyboard and screen-reader users, and what has not been audited yet.', Component: Accessibility },
  { path: 'brand', title: 'Brand assets · Flint', description: 'The Flint icon, colors, typography and screenshots, and how to use them.', Component: Brand },
]

export const NOT_FOUND: PageDef = { path: '404', title: 'Page not found · Flint', description: 'This page does not exist.', Component: NotFound }

export const findPage = (path: string): PageDef | undefined => PAGES.find((p) => p.path === path)
