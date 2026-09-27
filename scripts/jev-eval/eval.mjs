#!/usr/bin/env node
/**
 * Jev vs. Flint on labeled tasks -- the gate before either Jev opt-in is
 * turned on by default.
 *
 *   node scripts/jev-eval/eval.mjs [--split holdout|dev|all] [--out report.md]
 *                                  [--baseline-order recorded.json]
 *
 * Flint's arm always runs, offline. Jev's arm runs only with TYPESAFE_API_KEY
 * set and api.typesafe.ai reachable; otherwise the report says "not
 * measured" -- it never invents a Jev number. The requests mirror
 * `src-tauri/src/core/jev/mod.rs` (same pinned model, same question shapes,
 * same thresholds), so what is measured is what the app would do.
 *
 * Baselines:
 * - skills: Flint offers no suggestion today; the model reads the catalog.
 *   The measurable stand-in is catalog search -- the lexical match
 *   `skill_list` does -- scored as "suggest the best match, or none".
 * - retrieval: the shortlist in the order Flint's search returned it. Without
 *   an embedding model here, a TF-IDF cosine order stands in; pass
 *   `--baseline-order` with orders recorded from Flint to gate on the real one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const MODEL = 'jev-1.13.0'
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const SKILL_MIN_PROBABILITY = 0.7
export const RERANK_MIN_RELEVANCE = 0.1
export const USD_PER_M_INPUT_TOKENS = 0.042

const STOP = new Set(
  'a an and are as at be by can do does for from how i in is it my of on or our so the this to we what when which who why with you your'.split(' ')
)

export function tokens(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t))
}

// --- Flint's arm ----------------------------------------------------------------

/** Catalog search: the skill sharing the most words with the request, or none. */
export function lexicalSkill(text, catalog, minOverlap = 2) {
  const want = new Set(tokens(text))
  let best = null
  let bestScore = 0
  for (const s of catalog) {
    const have = new Set(tokens(`${s.name.replace(/-/g, ' ')} ${s.description}`))
    const score = [...want].filter((t) => have.has(t)).length
    if (score > bestScore) {
      best = s.name
      bestScore = score
    }
  }
  return bestScore >= minOverlap ? best : null
}

/** TF-IDF cosine order of a shortlist: the stand-in for embedding order. */
export function tfidfOrder(query, passages) {
  const ids = Object.keys(passages)
  const docs = ids.map((id) => tokens(passages[id]))
  const df = new Map()
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1)
  const idf = (t) => Math.log((ids.length + 1) / ((df.get(t) ?? 0) + 1)) + 1
  const vec = (toks) => {
    const v = new Map()
    for (const t of toks) v.set(t, (v.get(t) ?? 0) + idf(t))
    return v
  }
  const cos = (a, b) => {
    let dot = 0
    for (const [t, x] of a) dot += x * (b.get(t) ?? 0)
    const n = (m) => Math.sqrt([...m.values()].reduce((s, x) => s + x * x, 0)) || 1
    return dot / (n(a) * n(b))
  }
  const q = vec(tokens(query))
  return ids
    .map((id, i) => ({ id, i, s: cos(q, vec(docs[i])) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.id)
}

// --- metrics ----------------------------------------------------------------------

export function skillMetrics(rows) {
  const n = rows.length
  const correct = rows.filter((r) => r.pred === r.gold).length
  const suggested = rows.filter((r) => r.pred !== null)
  const rightSuggestions = suggested.filter((r) => r.pred === r.gold).length
  const shouldSuggest = rows.filter((r) => r.gold !== null)
  const found = shouldSuggest.filter((r) => r.pred === r.gold).length
  const wrongOnNone = rows.filter((r) => r.gold === null && r.pred !== null).length
  return {
    n,
    accuracy: n ? correct / n : 0,
    precision: suggested.length ? rightSuggestions / suggested.length : null,
    recall: shouldSuggest.length ? found / shouldSuggest.length : null,
    falseSuggestionsOnNone: wrongOnNone,
  }
}

export function retrievalMetrics(rows, k = 3) {
  const n = rows.length
  let hit1 = 0
  let hitK = 0
  let rr = 0
  for (const { order, gold } of rows) {
    const rank = order.findIndex((id) => gold.includes(id))
    if (rank === 0) hit1++
    if (rank >= 0 && rank < k) hitK++
    if (rank >= 0) rr += 1 / (rank + 1)
  }
  return { n, hitAt1: n ? hit1 / n : 0, [`hitAt${k}`]: n ? hitK / n : 0, mrr: n ? rr / n : 0 }
}

// --- Jev's arm (the same requests the app makes) ---------------------------------

export function skillRequest(text, catalog) {
  const criteria = { none: 'No listed skill fits this request; answer normally.' }
  catalog.forEach((s, i) => {
    criteria[`s${i}`] = `${s.name.slice(0, 80)}: ${s.description.slice(0, 200)}`
  })
  return {
    model: MODEL,
    state: { request: text.slice(0, 2000) },
    questions: {
      skill: {
        type: 'choice',
        instructions:
          'Which one skill, if any, should an assistant load to handle this request? Choose none unless a skill clearly applies.',
        criteria,
      },
    },
  }
}

export function readSkill(resp, catalog) {
  const a = resp?.answers?.skill
  if (!a || a.type !== 'choice') return { pred: null, fallback: 'bad_response' }
  const p = a.probabilities?.[a.choice] ?? 0
  if (a.choice === 'none') return { pred: null, fallback: 'abstained', p }
  const idx = Number(String(a.choice).replace(/^s/, ''))
  if (!Number.isInteger(idx) || !catalog[idx]) return { pred: null, fallback: 'bad_response' }
  if (p < SKILL_MIN_PROBABILITY) return { pred: null, fallback: 'abstained', p }
  return { pred: catalog[idx].name, fallback: null, p }
}

export function rerankRequest(query, ids, passages) {
  const state = { query: query.slice(0, 1000), passages: {} }
  const questions = {}
  ids.forEach((id, i) => {
    state.passages[`p${i}`] = passages[id].slice(0, 1200)
    questions[`p${i}`] = {
      type: 'noul',
      instructions: `Does passage p${i} contain information that helps answer the query?`,
    }
  })
  return { model: MODEL, state, questions }
}

export function readRerank(resp, ids) {
  const scored = []
  for (let i = 0; i < ids.length; i++) {
    const a = resp?.answers?.[`p${i}`]
    if (!a || a.type !== 'noul' || !Number.isFinite(a.noul)) return { order: ids, fallback: 'bad_response' }
    scored.push({ i, p: a.noul, id: ids[i] })
  }
  if (scored.every((s) => s.p < RERANK_MIN_RELEVANCE)) return { order: ids, fallback: 'abstained' }
  scored.sort((a, b) => b.p - a.p || a.i - b.i)
  return { order: scored.map((s) => s.id), fallback: null }
}

export async function callJev(body, { key, fetchImpl = fetch, timeoutMs = 5000 }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = performance.now()
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'error',
    })
    const ms = performance.now() - t0
    if (!res.ok) return { error: `HTTP ${res.status}`, ms }
    return { resp: await res.json(), ms }
  } catch (e) {
    return { error: ctrl.signal.aborted ? 'timeout' : String(e?.message ?? e), ms: performance.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

// --- the run ----------------------------------------------------------------------

export async function evaluate({ split = 'holdout', key, fetchImpl, baselineOrder } = {}) {
  const skills = JSON.parse(fs.readFileSync(path.join(here, 'skills.labeled.json'), 'utf8'))
  const retrieval = JSON.parse(fs.readFileSync(path.join(here, 'retrieval.labeled.json'), 'utf8'))
  const pick = (t) => split === 'all' || t.split === split
  const skillTasks = skills.tasks.filter(pick)
  const retrievalTasks = retrieval.tasks.filter(pick)

  const flintSkills = skillMetrics(
    skillTasks.map((t) => ({ gold: t.gold, pred: lexicalSkill(t.text, skills.catalog) }))
  )
  const flintOrders = retrievalTasks.map((t) => ({
    gold: t.gold,
    order: baselineOrder?.[t.query] ?? tfidfOrder(t.query, t.passages),
  }))
  const flintRetrieval = retrievalMetrics(flintOrders)

  const report = {
    split,
    model: MODEL,
    baselineRetrievalOrder: baselineOrder ? 'recorded Flint order' : 'TF-IDF proxy',
    flint: { skills: flintSkills, retrieval: flintRetrieval },
    jev: null,
    jevNotMeasured: null,
  }
  if (!key) {
    report.jevNotMeasured = 'TYPESAFE_API_KEY is not set'
    return report
  }

  const usage = { input: 0, output: 0, latencies: [], fallbacks: {} }
  const note = (r, fb) => {
    if (r?.usage) {
      usage.input += r.usage.input_tokens ?? 0
      usage.output += r.usage.output_tokens ?? 0
    }
    if (fb) usage.fallbacks[fb] = (usage.fallbacks[fb] ?? 0) + 1
  }
  const jevSkillRows = []
  let reached = 0
  for (const t of skillTasks) {
    const { resp, error, ms } = await callJev(skillRequest(t.text, skills.catalog), { key, fetchImpl })
    usage.latencies.push(ms)
    if (error) {
      // A failure falls back to Flint's own behaviour, as in the app.
      note(null, error === 'timeout' ? 'timeout' : 'http_error')
      jevSkillRows.push({ gold: t.gold, pred: null })
      continue
    }
    reached++
    const d = readSkill(resp, skills.catalog)
    note(resp, d.fallback)
    jevSkillRows.push({ gold: t.gold, pred: d.pred })
  }
  const jevOrders = []
  for (const [i, t] of retrievalTasks.entries()) {
    const ids = flintOrders[i].order
    const { resp, error, ms } = await callJev(rerankRequest(t.query, ids, t.passages), { key, fetchImpl })
    usage.latencies.push(ms)
    if (error) {
      note(null, error === 'timeout' ? 'timeout' : 'http_error')
      jevOrders.push({ gold: t.gold, order: ids })
      continue
    }
    reached++
    const d = readRerank(resp, ids)
    note(resp, d.fallback)
    jevOrders.push({ gold: t.gold, order: d.order })
  }
  if (reached === 0) {
    report.jevNotMeasured = `no request reached TypeSafe (${Object.keys(usage.fallbacks).join(', ')})`
    return report
  }
  const sorted = [...usage.latencies].sort((a, b) => a - b)
  report.jev = {
    skills: skillMetrics(jevSkillRows),
    retrieval: retrievalMetrics(jevOrders),
    requests: usage.latencies.length,
    latencyMs: { p50: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] },
    inputTokens: usage.input,
    outputTokens: usage.output,
    costUsd: (usage.input * USD_PER_M_INPUT_TOKENS) / 1e6,
    fallbacks: usage.fallbacks,
  }
  return report
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`)

export function toMarkdown(r) {
  const lines = [
    `# Jev evaluation (${r.split} split, ${r.model})`,
    '',
    '| Skill selection | Flint (catalog search) | Jev |',
    '| --- | --- | --- |',
  ]
  const js = r.jev?.skills
  for (const [label, key] of [['Accuracy (incl. none)', 'accuracy'], ['Precision of suggestions', 'precision'], ['Recall', 'recall']]) {
    lines.push(`| ${label} | ${pct(r.flint.skills[key])} | ${js ? pct(js[key]) : 'not measured'} |`)
  }
  lines.push(`| Wrong suggestion where none applies | ${r.flint.skills.falseSuggestionsOnNone} | ${js ? js.falseSuggestionsOnNone : 'not measured'} |`)
  lines.push('', `| Retrieval (baseline: ${r.baselineRetrievalOrder}) | Flint | Jev rerank |`, '| --- | --- | --- |')
  const jr = r.jev?.retrieval
  for (const [label, key] of [['Hit@1', 'hitAt1'], ['Hit@3', 'hitAt3'], ['MRR', 'mrr']]) {
    const f = key === 'mrr' ? r.flint.retrieval[key].toFixed(2) : pct(r.flint.retrieval[key])
    const j = jr ? (key === 'mrr' ? jr[key].toFixed(2) : pct(jr[key])) : 'not measured'
    lines.push(`| ${label} | ${f} | ${j} |`)
  }
  lines.push('')
  if (r.jev) {
    lines.push(
      `Jev: ${r.jev.requests} requests, latency p50 ${Math.round(r.jev.latencyMs.p50)} ms / max ${Math.round(r.jev.latencyMs.max)} ms, ${r.jev.inputTokens} input tokens (~$${r.jev.costUsd.toFixed(5)}), fallbacks ${JSON.stringify(r.jev.fallbacks)}.`
    )
  } else {
    lines.push(`Jev: not measured -- ${r.jevNotMeasured}. Both opt-ins stay off by default until this is measured.`)
  }
  return lines.join('\n') + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (name) => {
    const i = process.argv.indexOf(name)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const baseline = arg('--baseline-order')
  const report = await evaluate({
    split: arg('--split') ?? 'holdout',
    key: process.env.TYPESAFE_API_KEY || undefined,
    baselineOrder: baseline ? JSON.parse(fs.readFileSync(baseline, 'utf8')) : undefined,
  })
  const md = toMarkdown(report)
  const out = arg('--out')
  if (out) fs.writeFileSync(out, md)
  process.stdout.write(md)
  if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(report, null, 2))
}
