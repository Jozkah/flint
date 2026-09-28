import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { TypeSafeMark } from '@/components/ui/TypeSafeMark'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { usePrompt } from '@/hooks/usePrompt'
import { useJevSettings } from '@/hooks/useJevSettings'
import { loadSlashCatalog, type SlashSurface } from '@/lib/slashCatalog'
import {
  eligibleSkills,
  jevSuggestSkill,
  shouldAskForSkill,
  type SkillDecision,
} from '@/lib/jev'
import type { SlashCatalogEntry } from '@/lib/slashCommands'

/** Ask after the user pauses, not on every keystroke. */
export const SUGGEST_DEBOUNCE_MS = 1200

/**
 * A skill Jev suggests for what the user is typing, as a chip above the
 * composer. Only a hint: nothing is invoked until the user clicks "Use",
 * which writes the same `/skill` command they could have typed. The `/`
 * menu, the skills the run can load itself, and every permission are
 * unchanged. Renders nothing unless the skill opt-in is `on` and Jev chose
 * one of this surface's own skills confidently.
 */
export function JevSkillSuggestion({
  surface,
  project,
  draftScope,
  suggest = jevSuggestSkill,
  loadCatalog = loadSlashCatalog,
}: {
  surface: SlashSurface
  project?: string | null
  draftScope?: string
  suggest?: typeof jevSuggestSkill
  loadCatalog?: (surface: SlashSurface, project?: string | null) => Promise<SlashCatalogEntry[]>
}) {
  const { t } = useTranslation()
  const mode = useJevSettings((s) => s.skillMode)
  const prompt = usePrompt((s) =>
    draftScope ? (s.scoped?.[draftScope]?.prompt ?? '') : s.prompt
  )
  const [decision, setDecision] = useState<{ text: string; d: SkillDecision } | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const catalog = useRef<Promise<SlashCatalogEntry[]> | null>(null)

  useEffect(() => {
    catalog.current = null
  }, [surface, project])

  useEffect(() => {
    // Off: nothing is asked, not even the catalog.
    if (mode === 'off' || !shouldAskForSkill(prompt)) {
      setDecision(null)
      return
    }
    let alive = true
    const timer = setTimeout(async () => {
      catalog.current ??= loadCatalog(surface, project).catch(() => [])
      const skills = eligibleSkills(await catalog.current)
      if (!alive || skills.length === 0) return
      try {
        const d = await suggest(prompt, skills)
        if (alive) setDecision({ text: prompt, d })
      } catch {
        // Existing behaviour stands: no chip.
      }
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [mode, prompt, surface, project, suggest, loadCatalog])

  const skill = decision?.d.skill
  if (mode !== 'on' || !skill || decision.text !== prompt || dismissed === `${skill}\n${prompt}`) {
    return null
  }
  const use = () => {
    const next = `/${skill} ${prompt.trim()}`
    const store = usePrompt.getState()
    if (draftScope) store.setScopedPrompt(draftScope, next)
    else store.setPrompt(next)
  }
  return (
    <div
      data-testid="jev-skill-suggestion"
      className="mb-2 flex items-center gap-2 rounded-[10px] bg-muted px-3 py-1.5 text-xs"
    >
      <TypeSafeMark size={14} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">
        {t('common:jev.suggestion', { skill })}
      </span>
      <span className="flex-1" />
      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" data-testid="jev-skill-use" onClick={use}>
        {t('common:jev.useSkill')}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('common:jev.dismiss')}
        onClick={() => setDismissed(`${skill}\n${prompt}`)}
      >
        <X />
      </Button>
    </div>
  )
}
