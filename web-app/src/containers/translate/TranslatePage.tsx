import { useEffect, useRef, useState } from 'react'
import { streamText } from 'ai'
import {
  ArrowLeftRight,
  ClipboardPaste,
  Copy,
  Languages,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { LanguagePicker } from './LanguagePicker'
import { Textarea } from '@/components/ui/textarea'
import { useTranslateDraft } from '@/hooks/useTranslateDraft'
import { useModelProvider } from '@/hooks/useModelProvider'
import { ModelFactory } from '@/lib/model-factory'
import {
  classifyTranslateError,
  cleanTranslation,
  describeFailure,
} from '@/lib/translateError'
import { AUTO_LANGUAGE, buildTranslatePrompt } from '@/lib/translatePrompt'
import { useTranslation } from '@/i18n/react-i18next-compat'

const ERROR_KEYS = {
  auth: 'common:translate.errorAuth',
  quota: 'common:translate.errorQuota',
  modelNotFound: 'common:translate.errorModelNotFound',
  engineUnavailable: 'common:translate.errorEngine',
  network: 'common:translate.errorNetwork',
} as const

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * One-shot translation with the model picked in the model selector. Nothing is
 * saved: each run is a single user turn, so history never bloats the context.
 */
export function TranslatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const selectedModel = useModelProvider((s) => s.selectedModel)
  const selectedProvider = useModelProvider((s) => s.selectedProvider)
  const getProviderByName = useModelProvider((s) => s.getProviderByName)

  const source = useTranslateDraft((s) => s.source)
  const target = useTranslateDraft((s) => s.target)
  const input = useTranslateDraft((s) => s.input)
  const output = useTranslateDraft((s) => s.output)
  const setSource = useTranslateDraft((s) => s.setSource)
  const setTarget = useTranslateDraft((s) => s.setTarget)
  const setInput = useTranslateDraft((s) => s.setInput)
  const setOutput = useTranslateDraft((s) => s.setOutput)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Leaving the page mid-stream must stop pulling tokens.
  useEffect(() => () => abortRef.current?.abort(), [])

  const provider = getProviderByName(selectedProvider)
  const errorKind = error ? classifyTranslateError(error) : null
  const canRun = !!selectedModel && !!provider && input.trim().length > 0

  const run = async () => {
    // abortRef is set synchronously, so a second trigger fired before the
    // re-render still sees a run in flight.
    if (
      running ||
      abortRef.current ||
      !selectedModel ||
      !provider ||
      !input.trim()
    )
      return
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setOutput('')
    setError(null)
    try {
      const model = await ModelFactory.createModel(selectedModel.id, provider)
      // streamText swallows request errors (an unreachable server, a bad
      // key, a model that is not loaded) and just ends the stream empty, so
      // they have to be caught here or the page looks like it did nothing.
      let streamError: unknown
      const result = streamText({
        model,
        prompt: buildTranslatePrompt(input.trim(), source, target),
        abortSignal: controller.signal,
        maxRetries: 0,
        onError: ({ error }) => {
          streamError ??= error
        },
      })
      let text = ''
      for await (const delta of result.textStream) {
        text += delta
        setOutput(cleanTranslation(text))
      }
      setOutput(cleanTranslation(text, true))
      if (streamError !== undefined) throw streamError
      if (!cleanTranslation(text, true) && !controller.signal.aborted) {
        throw new Error(t('common:translate.failed'))
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(describeFailure(e) || t('common:translate.failed'))
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const stop = () => abortRef.current?.abort()

  const swap = () => {
    // A running stream keeps writing the output; swapping now would be
    // overwritten by the next token.
    if (source === AUTO_LANGUAGE || running) return
    setSource(target)
    setTarget(source)
    setInput(output)
    setOutput(input)
    setError(null)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output)
      toast.success(t('common:translate.copied'))
    } catch {
      toast.error(t('common:translate.copyFailed'))
    }
  }

  // Only ever read on a click. If the browser or webview refuses (the first
  // click can raise a permission prompt the user dismisses), fall back to the
  // normal paste gesture: focus the box and say so.
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      const el = inputRef.current
      if (!input || !el) {
        setInput(text)
        return
      }
      // Never replace what the user typed: insert at the caret.
      const start = el.selectionStart ?? input.length
      const end = el.selectionEnd ?? start
      setInput(input.slice(0, start) + text + input.slice(end))
    } catch {
      inputRef.current?.focus()
      toast.error(t('common:translate.pasteFailed'), {
        description: t('common:translate.pasteHint', {
          keys: isMac ? '⌘V' : 'Ctrl+V',
        }),
      })
    }
  }

  const clear = () => {
    if (running) return
    setInput('')
    setOutput('')
    setError(null)
  }

  return (
    <div
      className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 sm:p-6"
      data-testid="translate-page"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          if (canRun) void run()
        }
      }}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex items-center gap-2">
            <Languages className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-base font-semibold">
              {t('common:translate.title')}
            </h1>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('common:translate.description')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div data-testid="translate-model">
            <DropdownModelProvider useLastUsedModel />
          </div>
          {running ? (
            <Button
              variant="outline"
              onClick={stop}
              data-testid="translate-stop"
            >
              <Square />
              {t('common:translate.stop')}
            </Button>
          ) : (
            <Button
              onClick={run}
              disabled={!canRun}
              data-testid="translate-run"
              title={t('common:translate.shortcut')}
            >
              {t('common:translate.translate')}
              <KbdGroup className="hidden gap-0.5 sm:inline-flex">
                <Kbd className="bg-transparent">{isMac ? '⌘' : 'Ctrl'}</Kbd>
                <Kbd className="bg-transparent">↵</Kbd>
              </KbdGroup>
            </Button>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-2">
        <Frame
          className="min-h-80 md:min-h-0"
          data-testid="translate-source-pane"
        >
          <FrameHeader
            actions={
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={paste}
                  aria-label={t('common:translate.paste')}
                  title={t('common:translate.paste')}
                  data-testid="translate-paste"
                >
                  <ClipboardPaste />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={clear}
                  disabled={running || (!input && !output)}
                  aria-label={t('common:translate.clear')}
                  title={t('common:translate.clear')}
                  data-testid="translate-clear"
                >
                  <X />
                </Button>
              </>
            }
          >
            <LanguagePicker
              value={source}
              onChange={setSource}
              allowAuto
              aria-label={t('common:translate.from')}
              data-testid="translate-source"
              className="w-44"
            />
          </FrameHeader>
          <FrameBody>
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('common:translate.inputPlaceholder')}
              aria-label={t('common:translate.sourceTitle')}
              // The text is in any language; squiggles would flag all of it.
              spellCheck={false}
              className="h-full min-h-48 flex-1 resize-none border-0 bg-transparent shadow-none field-sizing-fixed focus-visible:ring-0"
              data-testid="translate-input"
            />
            <div
              className="px-3 pb-2 text-right text-[11px] text-muted-foreground tabular-nums"
              data-testid="translate-count"
            >
              {t('common:translate.characters', { count: input.length })}
            </div>
          </FrameBody>
        </Frame>

        <div className="flex items-center justify-center">
          <Button
            variant="outline"
            size="icon"
            onClick={swap}
            disabled={source === AUTO_LANGUAGE || running}
            aria-label={t('common:translate.swap')}
            title={t('common:translate.swap')}
            className="rotate-90 md:rotate-0"
            data-testid="translate-swap"
          >
            <ArrowLeftRight />
          </Button>
        </div>

        <Frame
          className="min-h-80 md:min-h-0"
          data-testid="translate-target-pane"
        >
          <FrameHeader
            actions={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={copy}
                disabled={!output || running}
                aria-label={t('common:translate.copy')}
                title={t('common:translate.copy')}
                data-testid="translate-copy"
              >
                <Copy />
              </Button>
            }
          >
            <LanguagePicker
              value={target}
              onChange={setTarget}
              aria-label={t('common:translate.to')}
              data-testid="translate-target"
              className="w-44"
            />
          </FrameHeader>
          <FrameBody className="relative">
            <Textarea
              value={output}
              readOnly
              placeholder={
                running || error ? '' : t('common:translate.outputPlaceholder')
              }
              aria-label={t('common:translate.targetTitle')}
              aria-busy={running}
              spellCheck={false}
              className="h-full min-h-48 flex-1 resize-none border-0 bg-transparent shadow-none field-sizing-fixed focus-visible:ring-0"
              data-testid="translate-output"
            />
            {running && !output && (
              <div
                className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2.5 p-3"
                data-testid="translate-skeleton"
                role="status"
                aria-label={t('common:translate.translating')}
              >
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            )}
            {error && (
              <div
                role="alert"
                data-testid="translate-error"
                className="absolute inset-x-0 top-0 m-3 flex items-start gap-2 rounded-lg border-[0.8px] border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
              >
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                <div className="min-w-0 flex-1 break-words">
                  {errorKind ? (
                    <>
                      <p>{t(ERROR_KEYS[errorKind])}</p>
                      <Button
                        variant="link"
                        size="xs"
                        className="h-auto p-0 text-xs font-medium underline underline-offset-2"
                        onClick={() => navigate({ to: '/settings/providers' })}
                        data-testid="translate-error-settings"
                      >
                        {t('common:translate.openProvider')}
                      </Button>
                      <details className="mt-1">
                        <summary className="cursor-pointer">
                          {t('common:translate.errorDetails')}
                        </summary>
                        <p className="mt-1 opacity-80">{error}</p>
                      </details>
                    </>
                  ) : (
                    error
                  )}
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={run}
                  disabled={!canRun}
                >
                  {t('common:translate.retry')}
                </Button>
              </div>
            )}
            <div className="px-3 pb-2 text-right text-[11px] text-muted-foreground tabular-nums">
              {running
                ? t('common:translate.translating')
                : t('common:translate.characters', { count: output.length })}
            </div>
          </FrameBody>
        </Frame>
      </div>
    </div>
  )
}
