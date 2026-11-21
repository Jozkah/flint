import type { MCPServerConfig } from '@/hooks/useMCPServers'

/**
 * Optional MCP servers the Add dialog can prefill. Picking one only fills the
 * form: nothing is saved, installed or started until the user presses Save,
 * and no preset is ever added by default.
 */
export type McpPreset = {
  id: string
  /** Suggested server name. */
  name: string
  /** Translation key (mcp-servers namespace) for the button label. */
  labelKey: string
  /** Translation key for the honest note shown after the preset is applied. */
  noteKey: string
  /** Whether every query leaves the machine for a third party. */
  hosted: boolean
  config: Pick<MCPServerConfig, 'command' | 'args' | 'env' | 'type' | 'url'>
}

/** Placeholder the user must replace with the folder they cloned the repo into. */
export const RIVAL_SEARCH_CLONE_PLACEHOLDER = '/path/to/RivalSearchMCP'

/**
 * RivalSearchMCP (MIT, https://github.com/damionrashford/RivalSearchMCP):
 * keyless search, news, social and academic tools that scrape public sources.
 * It is not on PyPI, so the self-hosted entry runs `server.py` from a clone
 * with `uv`, as its README documents.
 */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'rivalsearch-local',
    name: 'RivalSearchMCP',
    labelKey: 'mcp-servers:presets.rivalsearchLocal.label',
    noteKey: 'mcp-servers:presets.rivalsearchLocal.note',
    hosted: false,
    config: {
      command: 'uv',
      args: [
        '--directory',
        RIVAL_SEARCH_CLONE_PLACEHOLDER,
        'run',
        'python',
        'server.py',
      ],
      env: {},
      type: 'stdio',
    },
  },
  {
    id: 'rivalsearch-hosted',
    name: 'RivalSearchMCP-hosted',
    labelKey: 'mcp-servers:presets.rivalsearchHosted.label',
    noteKey: 'mcp-servers:presets.rivalsearchHosted.note',
    hosted: true,
    config: {
      command: '',
      args: [],
      env: {},
      type: 'http',
      url: 'https://RivalSearchMCP.fastmcp.app/mcp',
    },
  },
]
