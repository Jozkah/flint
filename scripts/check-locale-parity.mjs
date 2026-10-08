#!/usr/bin/env node
// Checks that every locale in web-app/src/locales has the same shape as `en`.
//
//   node scripts/check-locale-parity.mjs [options]
//
// For each locale folder, each namespace file (`en/<ns>.json`) is compared with
// English by its flat key set (`a.b.c`; plural forms `key_one`, `key_other`, ...
// count as one key, since languages need different forms).
//
// Always an error:
//   - a file that is not valid JSON,
//   - a translated key whose `{{placeholders}}` differ from English's,
//   - a key (or a whole namespace file) a locale has and English does not.
//     Reported as an error in --lenient mode, as a warning otherwise.
// An error unless a flag relaxes it:
//   - a namespace English has and the locale lacks   (--allow-missing-namespaces, --lenient)
//   - a key English has and the locale lacks         (--lenient)
//
// Options:
//   --allow-missing-namespaces  a locale may lack whole namespace files; the
//                               keys of files it does have must still be complete
//   --lenient                   only malformed JSON, placeholder mismatches and
//                               keys absent from English fail; missing
//                               namespaces and keys are listed as warnings.
//                               What CI runs until every locale is translated.
//   --baseline=<file>           findings already listed in <file> (keys a locale
//                               has and English does not, placeholder
//                               mismatches) are warnings, so existing debt does
//                               not block while new ones still do
//   --write-baseline=<file>     write the current findings of that kind to <file>
//                               and exit 0 (shrink it as locales are fixed)
//   --locale=<code>             check one locale (e.g. --locale=de-DE)
//   --verbose                   list every finding, not the first few
//   --help
//
// Exit code: 1 when there is an error, else 0.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '../web-app/src/locales')
const BASE = 'en'
const PLURAL = /_(zero|one|two|few|many|other)$/
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g
const SHOWN = 12

/** `a.b.c` -> string, for every string leaf of a parsed JSON file. */
export function flatten(value, prefix = '', out = new Map()) {
  if (typeof value === 'string') {
    out.set(prefix, value)
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => flatten(item, prefix ? `${prefix}.${i}` : String(i), out))
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  }
  return out
}

/** Groups plural forms under one key: `{ base -> [values] }`. */
export function byBaseKey(flat) {
  const out = new Map()
  for (const [key, value] of flat) {
    const base = key.replace(PLURAL, '')
    out.set(base, [...(out.get(base) ?? []), value])
  }
  return out
}

/** The `{{names}}` used by any form of a key, sorted. */
export function placeholders(values) {
  const names = new Set()
  for (const v of values) for (const m of v.matchAll(PLACEHOLDER)) names.add(m[1])
  return [...names].sort()
}

function readJson(file) {
  try {
    return { data: JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

const namespaces = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .sort()
    : []

/**
 * Compares every locale under `root` with English.
 * Returns `{ errors: string[], warnings: string[], locales: string[] }`.
 */
export function checkLocales(root = DEFAULT_ROOT, options = {}) {
  const { allowMissingNamespaces = false, lenient = false, only = null, baseline = null } = options
  const errors = []
  const warnings = []
  // What a baseline file excuses, and what this run found of that kind.
  const found = {}
  const known = (file, kind, key) => {
    const entries = baseline?.[file]?.[kind] ?? []
    return entries.some((e) => e === key || (e.endsWith('.*') && key.startsWith(e.slice(0, -1))))
  }
  const record = (file, kind, keys) => {
    ;(found[file] ??= {})[kind] = keys
  }
  const baseDir = join(root, BASE)
  const baseNamespaces = namespaces(baseDir)
  if (baseNamespaces.length === 0) {
    return { errors: [`no ${BASE} namespaces found in ${baseDir}`], warnings, locales: [] }
  }

  const base = new Map()
  for (const ns of baseNamespaces) {
    const parsed = readJson(join(baseDir, `${ns}.json`))
    if (parsed.error) errors.push(`${BASE}/${ns}.json: not valid JSON: ${parsed.error}`)
    else base.set(ns, byBaseKey(flatten(parsed.data)))
  }

  const locales = readdirSync(root)
    .filter((d) => d !== BASE && d !== '__tests__' && statSync(join(root, d)).isDirectory())
    .filter((d) => !only || d === only)
    .sort()

  for (const locale of locales) {
    const dir = join(root, locale)
    const have = new Set(namespaces(dir))

    const missingNs = baseNamespaces.filter((ns) => !have.has(ns))
    for (const ns of missingNs) {
      const line = `${locale}: missing namespace file ${ns}.json`
      ;(allowMissingNamespaces || lenient ? warnings : errors).push(line)
    }
    for (const ns of [...have].filter((n) => !base.has(n) && !baseNamespaces.includes(n))) {
      ;(lenient ? errors : warnings).push(`${locale}: ${ns}.json has no English counterpart`)
    }

    for (const ns of baseNamespaces) {
      if (!have.has(ns) || !base.has(ns)) continue
      const file = `${locale}/${ns}.json`
      const parsed = readJson(join(dir, `${ns}.json`))
      if (parsed.error) {
        errors.push(`${file}: not valid JSON: ${parsed.error}`)
        continue
      }
      const english = base.get(ns)
      const theirs = byBaseKey(flatten(parsed.data))

      const missing = [...english.keys()].filter((k) => !theirs.has(k))
      if (missing.length) (lenient ? warnings : errors).push(`${file}: ${missing.length} missing key(s): ${list(missing)}`)

      const extra = [...theirs.keys()].filter((k) => !english.has(k))
      if (extra.length) record(file, 'extra', extra)
      const newExtra = extra.filter((k) => !known(file, 'extra', k))
      const knownExtra = extra.length - newExtra.length
      if (knownExtra) warnings.push(`${file}: ${knownExtra} key(s) not in ${BASE} (in the baseline)`)
      if (newExtra.length) (lenient ? errors : warnings).push(`${file}: ${newExtra.length} key(s) not in ${BASE}: ${list(newExtra)}`)

      const drift = []
      const driftKeys = []
      const show = (names) => (names.length ? names.map((n) => `{{${n}}}`).join(', ') : 'none')
      for (const [key, values] of theirs) {
        const want = english.get(key)
        if (!want) continue
        const a = placeholders(want)
        const b = placeholders(values)
        if (a.join() === b.join()) continue
        driftKeys.push(key)
        if (!known(file, 'placeholders', key)) drift.push(`${key} (${BASE}: ${show(a)} / ${locale}: ${show(b)})`)
      }
      if (driftKeys.length) record(file, 'placeholders', driftKeys)
      const knownDrift = driftKeys.length - drift.length
      if (knownDrift) warnings.push(`${file}: ${knownDrift} placeholder mismatch(es) (in the baseline)`)
      if (drift.length) errors.push(`${file}: ${drift.length} placeholder mismatch(es): ${list(drift)}`)
    }
  }
  return { errors, warnings, locales, found }
}

/** `{ file: { kind: [keys] } }` as a baseline: a whole subtree becomes `prefix.*`. */
export function toBaseline(found) {
  const out = {}
  for (const [file, kinds] of Object.entries(found).sort(([a], [b]) => a.localeCompare(b))) {
    out[file] = {}
    for (const [kind, keys] of Object.entries(kinds)) {
      const groups = new Map()
      for (const k of keys) groups.set(k.split('.')[0], [...(groups.get(k.split('.')[0]) ?? []), k])
      const entries = []
      for (const [head, members] of groups) {
        entries.push(...(members.length > 3 && members.every((m) => m.includes('.')) ? [`${head}.*`] : members))
      }
      out[file][kind] = entries.sort()
    }
  }
  return out
}

let verbose = false
function list(items) {
  const shown = verbose ? items : items.slice(0, SHOWN)
  return shown.join(', ') + (items.length > shown.length ? `, ... and ${items.length - shown.length} more` : '')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
    return 0
  }
  verbose = args.includes('--verbose')
  const value = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null
  const only = args.find((a) => a.startsWith('--locale='))?.slice('--locale='.length) ?? null
  const baselineFile = value('--baseline')
  let baseline = null
  if (baselineFile) {
    const parsed = readJson(resolve(baselineFile))
    if (parsed.error) {
      console.error(`error: ${baselineFile}: ${parsed.error}`)
      return 1
    }
    baseline = parsed.data
  }
  const unknown = args.filter(
    (a) => !['--allow-missing-namespaces', '--lenient', '--verbose', '--help'].includes(a) && !/^--(locale|baseline|write-baseline)=/.test(a)
  )
  if (unknown.length) {
    console.error(`unknown option(s): ${unknown.join(' ')} (see --help)`)
    return 2
  }
  const { errors, warnings, locales, found } = checkLocales(DEFAULT_ROOT, {
    allowMissingNamespaces: args.includes('--allow-missing-namespaces'),
    lenient: args.includes('--lenient'),
    only,
    baseline,
  })
  const writeTo = value('--write-baseline')
  if (writeTo) {
    writeFileSync(resolve(writeTo), `${JSON.stringify(toBaseline(found), null, 2)}
`)
    console.log(`baseline written to ${writeTo}: ${Object.keys(found).length} file(s)`)
    return 0
  }
  for (const w of warnings) console.warn(`warning: ${w}`)
  for (const e of errors) console.error(`error: ${e}`)
  console.log(`locales checked: ${locales.length}; errors: ${errors.length}; warnings: ${warnings.length}`)
  return errors.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
