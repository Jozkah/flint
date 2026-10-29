import { useCallback, useMemo, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { route } from '@/constants/routes'
import {
  requestChatCompaction,
  requestChatSideQuestion,
} from '@/lib/chatCompaction'
import {
  fillPrompt,
  parseVars,
  promptSlug,
  usePromptLibrary,
  type LibraryPrompt,
} from '@/lib/promptLibrary'
import type { SlashBuiltin } from '@/lib/slashCommands'
import { useSlashCommands, type SlashSurface } from '@/hooks/useSlashCommands'
import { useTranslation } from '@/i18n/react-i18next-compat'

export type PromptFill = {
  prompt: LibraryPrompt
  apply: (text: string) => void
  /** Undoes what started the insert (the typed `@query`). */
  cancel?: () => void
}

/**
 * The composer's `/` commands: the surface's built-ins (Home: `/new`,
 * `/compact`, `/btw`), one per library prompt, and the fill-in dialog state a
 * prompt with variables opens.
 */
export function useComposerSlashCommands({
  slashSurface,
  slashProject,
  slashBuiltins,
  currentThreadId,
  setPrompt,
}: {
  slashSurface: SlashSurface
  slashProject?: string | null
  slashBuiltins?: SlashBuiltin[]
  currentThreadId: string | undefined
  setPrompt: (value: string) => void
}) {
  const { t } = useTranslation()
  const router = useRouter()
  const defaultSlashBuiltins = useMemo<SlashBuiltin[]>(
    () =>
      slashSurface === 'home'
        ? [
            {
              name: 'new',
              description: t('slash:builtin.new'),
              run: () => void router.navigate({ to: route.home }),
            },
            // Only in an open conversation, which registers how to compact
            // itself (`lib/chatCompaction.ts`).
            ...(currentThreadId
              ? [
                  {
                    name: 'compact',
                    description: t('slash:builtin.compact'),
                    argumentHint: '[focus]',
                    run: (args: string) => {
                      if (
                        !requestChatCompaction(
                          currentThreadId,
                          args.trim() || undefined
                        )
                      ) {
                        toast.info(t('common:budget.compactFailed'))
                      }
                    },
                  },
                  {
                    name: 'btw',
                    description: t('slash:builtin.btw'),
                    argumentHint: '<question>',
                    run: (args: string) => {
                      const question = args.trim()
                      if (
                        !question ||
                        !requestChatSideQuestion(currentThreadId, question)
                      ) {
                        toast.info(t('common:budget.btwFailed'))
                      }
                    },
                  },
                ]
              : []),
          ]
        : [],
    [slashSurface, t, router, currentThreadId]
  )
  // Prompt library (AH-prompts): one state for the fill-in dialog, whichever
  // menu started the insert.
  const libraryPrompts = usePromptLibrary((s) => s.prompts)
  const [promptFill, setPromptFill] = useState<PromptFill | null>(null)
  /** Insert now when the prompt has no variables, else ask for them first. */
  const beginPromptInsert = useCallback(
    (
      prompt: LibraryPrompt,
      apply: (text: string) => void,
      cancel?: () => void
    ) => {
      if (parseVars(prompt.body).length === 0) {
        apply(fillPrompt(prompt.body, {}))
        return
      }
      setPromptFill({ prompt, apply, cancel })
    },
    []
  )
  const promptBuiltins = useMemo<SlashBuiltin[]>(() => {
    const used = new Set<string>()
    return libraryPrompts.map((p) => {
      let slug = promptSlug(p.name)
      for (let n = 2; used.has(slug); n++) slug = `${promptSlug(p.name)}-${n}`
      used.add(slug)
      return {
        name: `prompt:${slug}`,
        description: p.name,
        promptId: p.id,
        // Typed in full and sent: the draft is cleared by the send, so the
        // insert lands after it.
        run: () => {
          setTimeout(() => beginPromptInsert(p, (text) => setPrompt(text)), 0)
        },
      }
    })
  }, [libraryPrompts, beginPromptInsert, setPrompt])
  const slashCommands = useSlashCommands({
    surface: slashSurface,
    project: slashProject,
    builtins: [...(slashBuiltins ?? defaultSlashBuiltins), ...promptBuiltins],
    helpDescription: t('slash:builtin.help'),
  })
  return {
    slashCommands,
    libraryPrompts,
    promptFill,
    setPromptFill,
    beginPromptInsert,
  }
}
