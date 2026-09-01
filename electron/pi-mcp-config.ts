import { buildSdkMcpServers, CLAW_MCP_KEY } from "../src/shared/harness-mcp-store.js"

/** pi-mcp-adapter ServerEntry Â≠êÈ??Ôº?ÈÅøÂ??tsc Ê??Âè? adapter Ê∫êÁ†ÅÔº?*/
export interface PiMcpServerEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager"
  requestTimeoutMs?: number
  disabled?: boolean
}

export interface PiMcpConfig {
  mcpServers: Record<string, PiMcpServerEntry>
}

function normalizeServerEntry(cfg: Record<string, unknown>): PiMcpServerEntry {
  const entry = { ...cfg } as PiMcpServerEntry
  if (entry.url && !entry.lifecycle) entry.lifecycle = "eager"
  if (entry.command && !entry.lifecycle) entry.lifecycle = "lazy"
  return entry
}

/** LLM host mode: no lk-harness outbound MCP (harness delivers assistant text) */
export function buildPiHostMcpConfig(port: number | null, includeAdmin: boolean): PiMcpConfig {
  const raw = { ...buildSdkMcpServers(port, includeAdmin) }
  delete raw[CLAW_MCP_KEY]
  const mcpServers: Record<string, PiMcpServerEntry> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    mcpServers[name] = normalizeServerEntry(cfg)
  }
  return { mcpServers }
}

/** ‰∏?Cursor SDK `buildSdkMcpServers` Âê?Ê??Ôº?ËΩ¨‰∏?pi-mcp-adapter Â??Â≠? config */
export function buildPiMcpConfig(port: number | null, includeAdmin: boolean): PiMcpConfig {
  const raw = buildSdkMcpServers(port, includeAdmin)
  const mcpServers: Record<string, PiMcpServerEntry> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    mcpServers[name] = normalizeServerEntry(cfg)
  }
  return { mcpServers }
}
