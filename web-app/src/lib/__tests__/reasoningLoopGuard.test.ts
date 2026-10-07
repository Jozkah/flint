import { ReasoningLoopGuard } from '../reasoningLoopGuard'

describe('ReasoningLoopGuard', () => {
  it('stops a long repeated reasoning sequence across stream chunks', () => {
    const guard = new ReasoningLoopGuard()
    const phrase = '17892, 5228, 12804, 5228, '
    let repeated = false
    for (const chunk of (phrase.repeat(30)).match(/.{1,13}/g) ?? []) {
      repeated = guard.add(chunk) || repeated
    }
    expect(repeated).toBe(true)
  })

  it('stops a short unit repeated through a list, whatever its length', () => {
    for (const unit of ['5228, ', '5228, 12804, 17892, ', '5228, 12804, 5228, 17892, 42176, ']) {
      const guard = new ReasoningLoopGuard()
      let repeated = false
      for (let i = 0; i < 60 && !repeated; i++) repeated = guard.add(unit)
      expect(repeated).toBe(true)
    }
  })

  it('stops a repeat that follows ordinary reasoning', () => {
    const guard = new ReasoningLoopGuard()
    expect(guard.add('The user wants the ChatGPT process killed, so I list the processes first. ')).toBe(false)
    let repeated = false
    for (let i = 0; i < 40 && !repeated; i++) repeated = guard.add('5228, 12804, 17892, ')
    expect(repeated).toBe(true)
  })

  it('allows a few repeats, tables and numbered lists', () => {
    const guard = new ReasoningLoopGuard()
    const rows = ['| name | pid |', '|---|---|', '| chrome | 1 |', '| chrome | 2 |', '| chrome | 3 |']
    const table = rows.join(String.fromCharCode(10))
    expect(guard.add(table)).toBe(false)
    expect(guard.add('yes yes yes yes yes ')).toBe(false)
  })

  it('allows reasoning with changing content', () => {
    const guard = new ReasoningLoopGuard()
    for (let i = 0; i < 100; i++) {
      expect(guard.add(`Step ${i}: inspect distinct evidence ${i * i}. `)).toBe(false)
    }
  })
})
