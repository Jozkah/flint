/**
 * Measures how often a model hands work to `task` in its first turn.
 *   yarn vite-node scripts/subagent-delegation-rate.ts -- --base http://host:8559/v1 --model NAME --key KEY --trials 20
 * Delegable prompts should call `task`; trivial ones should not.
 */
import { taskTool } from '@/lib/coworkTools'
import { subagentGuide } from '@/lib/coworkPrompt'

const args = process.argv.slice(2)
const arg = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const base = arg('base', 'http://localhost:8080/v1')
const model = arg('model', '')
const key = arg('key', 'x')
const trials = Number(arg('trials', '20'))

const DELEGABLE = [
  'Survey the whole repo: for each of the packages web-app, src-tauri and core, find how errors are logged and report the pattern per package.',
  'I need to know every place the app reads settings from disk, they are spread across many files. Find them all and summarise.',
  'Audit the auth, billing and notifications modules separately and tell me the biggest risk in each.',
  'Go through all the test files and tell me which areas of the code have no tests at all.',
  'Investigate why startup is slow: look at the frontend boot, the Rust setup and the extension loading and report findings for each.',
]
const TRIVIAL = [
  'What is the version in package.json?',
  'Read src/main.tsx and tell me what it renders.',
  'Rename the variable foo to bar in utils.ts.',
  'What does the function parseSubagentRequest in coworkSubagent.ts return?',
  'Say hello.',
]

const fn = (
  name: string,
  description: string,
  props: Record<string, unknown>
) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: props,
      required: Object.keys(props),
    },
  },
})
const str = { type: 'string' }
const task = taskTool(['explore', 'general'])
const tools = [
  fn('read_file', 'Read a file.', { path: str }),
  fn('grep', 'Search file contents.', { pattern: str }),
  fn('list_dir', 'List a directory.', { path: str }),
  fn('edit_file', 'Edit a file.', { path: str, content: str }),
  {
    type: 'function',
    function: {
      name: 'task',
      description: task.description,
      parameters: (task.inputSchema as unknown as { jsonSchema: unknown })
        .jsonSchema,
    },
  },
]
const system =
  'You are a coding agent working in a repository.\n\n' +
  subagentGuide(['explore', 'general'])

async function firstCallNames(prompt: string): Promise<string[]> {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      tools,
      temperature: 0.7,
      max_tokens: 1500,
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  const j = (await r.json()) as {
    choices?: { message?: { tool_calls?: { function: { name: string } }[] } }[]
  }
  return (j.choices?.[0]?.message?.tool_calls ?? []).map((c) => c.function.name)
}

async function rate(prompts: string[]): Promise<number> {
  let hits = 0
  let n = 0
  for (const p of prompts) {
    let h = 0
    for (let i = 0; i < trials; i++) {
      const names = await firstCallNames(p).catch(() => [])
      if (names.includes('task')) h++
    }
    console.log(`${h}/${trials}  ${p.slice(0, 70)}`)
    hits += h
    n += trials
  }
  return (10 * hits) / n
}

const d = await rate(DELEGABLE)
const t = await rate(TRIVIAL)
console.log(
  `delegable: ${d.toFixed(1)}/10 (target >=9)  trivial: ${t.toFixed(1)}/10 (target <=1)`
)
