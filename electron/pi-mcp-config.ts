import { buildSdkMcpServers, CLAW_MCP_KEY } from "../src/shared/harness-mcp-store.js"

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

/** LLM 用 lk-harness MCP 的 /mcp-llm-host（send_text、send_question 等） */
export function buildPiHostMcpConfig(port: number | null, includeAdmin: boolean): PiMcpConfig {
  const raw = { ...buildSdkMcpServers(port, includeAdmin) }
  if (port != null && port > 0 && raw[CLAW_MCP_KEY]) {
    raw[CLAW_MCP_KEY] = { url: `http://127.0.0.1:${port}/mcp-llm-host` }
  }
  const mcpServers: Record<string, PiMcpServerEntry> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    mcpServers[name] = normalizeServerEntry(cfg)
  }
  return { mcpServers }
}

/** 与 Cursor SDK `buildSdkMcpServers` 相同，转为 pi-mcp-adapter config */
export function buildPiMcpConfig(port: number | null, includeAdmin: boolean): PiMcpConfig {
  const raw = buildSdkMcpServers(port, includeAdmin)
  const mcpServers: Record<string, PiMcpServerEntry> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    mcpServers[name] = normalizeServerEntry(cfg)
  }
  return { mcpServers }
}
