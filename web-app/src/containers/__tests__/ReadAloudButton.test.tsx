import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ReadAloudButton, resetReadAloudVoiceCheck } from '../ReadAloudButton'
import { speakableText, stopReadAloud } from '@/lib/readAloud'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: () => null,
}))

type Utt = { text: string; onend?: () => void; onerror?: () => void }

function installSpeech(voices: number) {
  const spoken: Utt[] = []
  const synth = {
    getVoices: vi.fn(() => Array.from({ length: voices }, () => ({}))),
    speak: vi.fn((u: Utt) => spoken.push(u)),
    cancel: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  Object.defineProperty(window, 'speechSynthesis', {
    value: synth,
    configurable: true,
  })
  ;(globalThis as Record<string, unknown>).SpeechSynthesisUtterance = class {
    text: string
    constructor(text: string) {
      this.text = text
    }
  }
  return { synth, spoken }
}

function removeSpeech() {
  delete (window as unknown as Record<string, unknown>).speechSynthesis
  delete (globalThis as Record<string, unknown>).SpeechSynthesisUtterance
}

beforeEach(() => resetReadAloudVoiceCheck())
afterEach(() => {
  act(() => stopReadAloud())
  removeSpeech()
  vi.useRealTimers()
})

describe('speakableText', () => {
  it('strips markdown, replaces code blocks, drops thinking', () => {
    const md = [
      '<think>secret plan</think>',
      '# Title',
      'Some **bold** and *italic* with `x` and [a link](http://x).',
      '```js',
      'const a = 1',
      '```',
      '- item one',
    ].join('\n')
    const out = speakableText(md, 'code omitted')
    expect(out).not.toContain('secret')
    expect(out).not.toContain('const a')
    expect(out).toContain('code omitted.')
    expect(out).toContain('Title')
    expect(out).toContain('Some bold and italic with x and a link.')
    expect(out).toContain('item one')
    expect(out).not.toMatch(/[*#`[\]]/)
  })
})

describe('ReadAloudButton', () => {
  it('starts and stops reading', async () => {
    const { synth, spoken } = installSpeech(2)
    render(<ReadAloudButton messageId="m1" text="Hello **there**" />)
    const btn = await screen.findByLabelText('chat:actions.readAloud')
    fireEvent.click(btn)
    expect(spoken[0].text).toBe('Hello there')
    const stop = screen.getByLabelText('chat:actions.stopReading')
    fireEvent.click(stop)
    expect(synth.cancel).toHaveBeenCalled()
    expect(screen.getByLabelText('chat:actions.readAloud')).toBeTruthy()
  })

  it('only one message speaks at a time', async () => {
    const { spoken } = installSpeech(1)
    render(
      <>
        <ReadAloudButton messageId="a" text="first" />
        <ReadAloudButton messageId="b" text="second" />
      </>
    )
    const buttons = await screen.findAllByLabelText('chat:actions.readAloud')
    fireEvent.click(buttons[0])
    fireEvent.click(screen.getByLabelText('chat:actions.readAloud'))
    expect(spoken.map((u) => u.text)).toEqual(['first', 'second'])
    expect(screen.getAllByLabelText('chat:actions.stopReading')).toHaveLength(1)
    // The first utterance's late end must not clear the second speaker.
    act(() => spoken[0].onend?.())
    expect(screen.getAllByLabelText('chat:actions.stopReading')).toHaveLength(1)
  })

  it('stops when unmounted (thread change)', async () => {
    const { synth } = installSpeech(1)
    const { unmount } = render(<ReadAloudButton messageId="m" text="hi" />)
    fireEvent.click(await screen.findByLabelText('chat:actions.readAloud'))
    synth.cancel.mockClear()
    unmount()
    expect(synth.cancel).toHaveBeenCalled()
  })

  it('is hidden when speechSynthesis is missing', async () => {
    removeSpeech()
    const { container } = render(<ReadAloudButton messageId="m" text="hi" />)
    await act(async () => {})
    expect(container.innerHTML).toBe('')
  })

  it('is hidden when no voices arrive', async () => {
    vi.useFakeTimers()
    installSpeech(0)
    const { container } = render(<ReadAloudButton messageId="m" text="hi" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(container.innerHTML).toBe('')
  })
})
