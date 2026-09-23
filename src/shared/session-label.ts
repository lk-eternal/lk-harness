import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { chatIdFromSessionKey, normalizeSessionKey, parseChatKey, workspaceDirFromSessionKey } from "./channel-types.js"
import { projectIdFromSessionKey, type Project } from "./project-types.js"

export type SessionCardTitle = { title: string; subtitle?: string }

const SESSION_HEADER_TEMPLATES = [
  "turquoise", "blue", "wathet", "indigo", "violet", "purple",
  "carmine", "orange", "red", "green",
] as const

export function sessionColorKey(sessionKey?: string): string {
  if (!sessionKey) return ""
  const sk = normalizeSessionKey(sessionKey) || sessionKey
  const pid = projectIdFromSessionKey(sk)
  if (pid) return `project:${pid}`
  const chat = parseChatKey(chatIdFromSessionKey(sk)).chatId
  const ws = workspaceDirFromSessionKey(sk)
  if (ws) {
    const norm = path.normalize(ws).replace(/[\\/]+$/, "").toLowerCase()
    return `ws:${chat}::${norm}`
  }
  return `chat:${chat}`
}

export function sessionHeaderTemplate(sessionKey?: string): string | undefined {
  const key = sessionColorKey(sessionKey)
  if (!key) return undefined
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return SESSION_HEADER_TEMPLATES[h % SESSION_HEADER_TEMPLATES.length]
}

export function readGitBranch(dir: string): string | undefined {
  try {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    })
    const b = (r.stdout || "").trim()
    if (r.status === 0 && b && b !== "HEAD") return b
    if (r.status === 0 && b === "HEAD") {
      const sh = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      })
      const sha = (sh.stdout || "").trim()
      return sha ? `HEAD(${sha})` : "HEAD"
    }
  } catch { /* not a git repo */ }
  return undefined
}

export function dirBaseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

export function isSpecialSessionSuffix(suffix: string): boolean {
  return suffix.startsWith("project_")
}

export function buildSessionCardTitle(opts: {
  sessionKey?: string
  project?: Project
  workspaceDir?: string
  fallbackDir?: string
  peers?: string[]
}): SessionCardTitle | undefined {
  const pid = opts.sessionKey ? projectIdFromSessionKey(opts.sessionKey) : undefined
  if (pid || opts.project) {
    const p = opts.project
    const name = p?.name || pid || "project"
    const branch = p?.featureBranch || (p?.worktreePath ? readGitBranch(p.worktreePath) : undefined)
    return { title: `📦 ${name}`, subtitle: branch ? `🌿 ${branch}` : undefined }
  }
  const dir = opts.workspaceDir || opts.fallbackDir
  if (!dir) return undefined
  const branch = readGitBranch(dir)
  return { title: `📂 ${dirBaseName(dir)}`, subtitle: branch ? `🌿 ${branch}` : undefined }
}

export function formatSessionLabel(opts: {
  sessionKey?: string
  project?: Project
  workspaceDir?: string
  peers?: string[]
}): string {
  const card = buildSessionCardTitle(opts)
  if (!card) return opts.sessionKey || "(未知会话)"
  return card.subtitle ? `${card.title} · ${card.subtitle}` : card.title
}

export function resolveWorkspaceFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined
  const idx = sessionKey.indexOf("::")
  if (idx < 0) return undefined
  const suffix = sessionKey.slice(idx + 2)
  if (!suffix || !/[\\/]/.test(suffix)) return undefined
  if (suffix.startsWith("project_")) return undefined
  return path.normalize(suffix)
}

