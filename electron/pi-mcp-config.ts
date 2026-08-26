import { buildSdkMcpServers } from "../src/shared/harness-mcp-store.js"

/** pi-mcp-adapter ServerEntry 子集（避�?tsc 拉取 adapter 源码�?*/
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

/** �?Cursor SDK `buildSdkMcpServers` 同构，转�?pi-mcp-adapter 内存 config */
export function buildPiMcpConfig(port: number | null, includeAdmin: boolean): PiMcpConfig {
  const raw = buildSdkMcpServers(port, includeAdmin)
  const mcpServers: Record<string, PiMcpServerEntry> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    mcpServers[name] = normalizeServerEntry(cfg)
  }
  return { mcpServers }
}
