import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArchitectures, pinnedTag, render } from './gen-llama-architectures.mjs'

const filler = Array.from({ length: 60 }, (_, i) => `    { LLM_ARCH_X${i}, "x${i}" },`).join('\n')
const source = `static const std::map<llm_arch, const char *> LLM_ARCH_NAMES = {
    { LLM_ARCH_CLIP,             "clip"             }, // dummy
    { LLM_ARCH_LLAMA,            "llama"            },
${filler}
};
`

test('reads every name in the table, in order', () => {
  const names = parseArchitectures(source)
  assert.equal(names.length, 62)
  assert.deepEqual(names.slice(0, 2), ['clip', 'llama'])
})

test('refuses a source with no table', () => {
  assert.throws(() => parseArchitectures('int main() {}'), /not found/)
})

test('finds the pinned tag and renders it', () => {
  assert.equal(pinnedTag('pub const LLAMA_CPP_TAG: &str = "b12359";'), 'b12359')
  assert.match(render('b12359', ['llama']), /LLAMA_CPP_ARCHITECTURES_TAG = 'b12359'[\s\S]*'llama',/)
})
