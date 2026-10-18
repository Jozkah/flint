import type { CodeHighlighterPlugin } from 'streamdown'
import { tooHeavyToHighlight } from '@/lib/highlightLimits'

/**
 * Wraps Streamdown's Shiki plugin so a block too big or too long-lined to
 * tokenise (minified JS, a 20k-char line) renders as plain text instead of
 * freezing the window. Returning null makes Streamdown keep its plain tokens.
 */
export function guardCodePlugin(
  plugin: CodeHighlighterPlugin
): CodeHighlighterPlugin {
  return {
    ...plugin,
    highlight: (options, callback) =>
      tooHeavyToHighlight(options.code)
        ? null
        : plugin.highlight(options, callback),
  }
}
