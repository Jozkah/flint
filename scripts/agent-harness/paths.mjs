import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this file so the scripts work from any cwd. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const JSON_PATH = join(REPO_ROOT, 'docs', 'agent-harness-features.json')
export const MARKDOWN_PATH = join(REPO_ROOT, 'docs', 'AGENT_HARNESS_FEATURE_REGISTRY.md')
