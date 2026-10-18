import type { MermaidConfig } from 'mermaid'

/**
 * Mermaid config matched to the app theme. Mermaid's "default" theme draws
 * edges in dark grey, which vanish on the dark code surface, so dark mode uses
 * mermaid's dark theme with light edge lines and labels.
 */
export const MERMAID_LIGHT: MermaidConfig = {
  theme: 'default',
  themeVariables: { lineColor: '#52525b' },
}

export const MERMAID_DARK: MermaidConfig = {
  theme: 'dark',
  darkMode: true,
  themeVariables: {
    darkMode: true,
    lineColor: '#d4d4d8',
    textColor: '#e4e4e7',
    edgeLabelBackground: '#27272a',
  },
}

export function mermaidConfigFor(isDark: boolean): MermaidConfig {
  return isDark ? MERMAID_DARK : MERMAID_LIGHT
}
