import { buildSdkMcpServers } from "../src/shared/harness-mcp-store.js"

/** pi-mcp-adapter ServerEntry 类型，避免 tsc 依赖 adapter 源码 */
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

/** 交互会话用 lk-harness MCP 的 /mcp-interactive（无 send_text，有 send_question/媒体/Diff）；项目会话另加 /mcp-project */
export function buildPiHostMcpConfig(port: number | null, includeAdmin: boolean, includeProject = false, invokerSessionKey?: string): PiMcpConfig {
  const raw = { ...buildSdkMcpServers(port, includeAdmin, "interactive", includeProject, invokerSessionKey) }
  const mcpServers: Record<string, PiMcpServerEntry> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    mcpServers[name] = normalizeServerEntry(cfg)
  }
  return { mcpServers }
}

/** 与 Cursor SDK `buildSdkMcpServers` 相同，转为 pi-mcp-adapter config */
export function buildPiMcpConfig(port: number | null, includeAdmin: boolean, includeProject = false, invokerSessionKey?: string): PiMcpConfig {
  const raw = buildSdkMcpServers(port, includeAdmin, "interactive", includeProject, invokerSessionKey)
  const mcpServers: Record<string, PiMcpServerEntry> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    mcpServers[name] = normalizeServerEntry(cfg)
  }
  return { mcpServers }
}
