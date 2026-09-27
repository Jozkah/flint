import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluate,
  lexicalSkill,
  readRerank,
  readSkill,
  retrievalMetrics,
  skillMetrics,
  skillRequest,
  tfidfOrder,
  toMarkdown,
  MODEL,
} from './jev-eval/eval.mjs'

test('without a key, Jev is reported as not measured and never guessed', async () => {
  const r = await evaluate({ split: 'holdout' })
  assert.equal(r.jev, null)
  assert.match(r.jevNotMeasured, /TYPESAFE_API_KEY/)
  assert.match(toMarkdown(r), /not measured/)
})

test('requests mirror the app: pinned model, positional skill keys, none option', () => {
  const body = skillRequest('x', [{ name: 'a', description: 'b' }])
  assert.equal(body.model, MODEL)
  assert.deepEqual(Object.keys(body.questions.skill.criteria), ['none', 's0'])
})

test('readers apply the app thresholds and fall back on bad answers', () => {
  const cat = [{ name: 'pdf', description: '' }]
  const ans = (choice, p) => ({ answers: { skill: { type: 'choice', choice, probabilities: { [choice]: p } } } })
  assert.equal(readSkill(ans('s0', 0.9), cat).pred, 'pdf')
  assert.equal(readSkill(ans('s0', 0.5), cat).pred, null)
  assert.equal(readSkill(ans('s9', 0.9), cat).fallback, 'bad_response')
  const r = readRerank({ answers: { p0: { type: 'noul', noul: 0.2 }, p1: { type: 'noul', noul: 0.8 } } }, ['a', 'b'])
  assert.deepEqual(r.order, ['b', 'a'])
  assert.equal(readRerank({ answers: {} }, ['a', 'b']).fallback, 'bad_response')
})

test('metrics', () => {
  const s = skillMetrics([
    { gold: 'a', pred: 'a' },
    { gold: null, pred: 'b' },
    { gold: 'c', pred: null },
    { gold: null, pred: null },
  ])
  assert.equal(s.accuracy, 0.5)
  assert.equal(s.precision, 0.5)
  assert.equal(s.recall, 0.5)
  assert.equal(s.falseSuggestionsOnNone, 1)
  const m = retrievalMetrics([{ order: ['x', 'g'], gold: ['g'] }, { order: ['g'], gold: ['g'] }])
  assert.equal(m.hitAt1, 0.5)
  assert.equal(m.mrr, 0.75)
})

test('baselines are deterministic', () => {
  const cat = [{ name: 'release-notes', description: 'Draft release notes from git history' }]
  assert.equal(lexicalSkill('write release notes from the git history', cat), 'release-notes')
  assert.equal(lexicalSkill('center a div', cat), null)
  assert.deepEqual(tfidfOrder('red apple', { a: 'green pear', b: 'a red apple' }), ['b', 'a'])
})

test('with a key, the Jev arm runs through fetch and falls back like the app on errors', async () => {
  let calls = 0
  const fetchImpl = async (url, init) => {
    calls++
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(init.headers.authorization, 'Bearer k')
    const body = JSON.parse(init.body)
    if (calls === 1) return { ok: false, status: 503 }
    const answers = {}
    if (body.questions.skill) answers.skill = { type: 'choice', choice: 'none', probabilities: { none: 1 } }
    for (const q of Object.keys(body.questions)) if (q.startsWith('p')) answers[q] = { type: 'noul', noul: 0.5 }
    return { ok: true, status: 200, json: async () => ({ model: MODEL, answers, usage: { input_tokens: 10, output_tokens: 1 } }) }
  }
  const r = await evaluate({ split: 'holdout', key: 'k', fetchImpl })
  assert.ok(r.jev)
  assert.equal(r.jev.fallbacks.http_error, 1)
  assert.ok(r.jev.inputTokens > 0)
  // Ties keep the baseline order, so an undecided Jev changes nothing.
  assert.deepEqual(r.jev.retrieval, r.flint.retrieval)
})

test('requests match the shared fixture the app is also tested against', async () => {
  const fs = await import('node:fs')
  const { rerankRequest } = await import('./jev-eval/eval.mjs')
  const fixture = JSON.parse(fs.readFileSync(new URL('./jev-eval/request.fixture.json', import.meta.url), 'utf8'))
  const { skill, rerank } = fixture.input
  assert.deepEqual(skillRequest(skill.message, skill.skills), fixture.expected.skill)
  const passages = Object.fromEntries(rerank.candidates.map((c) => [c.id, c.text]))
  assert.deepEqual(
    rerankRequest(rerank.query, rerank.candidates.map((c) => c.id), passages),
    fixture.expected.rerank
  )
})
