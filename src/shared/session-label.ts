import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { chatIdFromSessionKey, normalizeSessionKey, parseChatKey, workspaceDirFromSessionKey } from "./channel-types.js"
import { projectIdFromSessionKey, type Project } from "./project-types.js"

export type SessionCardTitle = { title: string; subtitle?: string }

/** 同一 sessionKey 稳定映射到飞�?header 色板（同会话同色、不同会话尽量区分） */
const SESSION_HEADER_TEMPLATES = [
  "turquoise", "blue", "wathet", "indigo", "violet", "purple",
  "carmine", "orange", "red", "green",
] as const

/** 配色用规�?key：忽略路径转�?大小�?通道前缀差异；项目按 projectId；普通会话按 chat+工作目录 */
export function sessionColorKey(sessionKey?: string): string {
  if (!sessionKey) return ""
  const sk = normalizeSessionKey(sessionKey) || sessionKey
  const pid = projectIdFromSessionKey(sk)
  if (pid) return `project:${pid}`
  // 剥通道前缀（ch_xxx|oc_yyy �?oc_yyy）：同一聊天在带/不带前缀两种 key 形态下必须同色
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

/** wf_/project_ 等非路径会话后缀；裸 temp_ 不带 :: */
export function isSpecialSessionSuffix(suffix: string): boolean {
  return suffix.startsWith("wf_") || suffix.startsWith("project_")
}

/** 飞书卡片 header：普通会话只显示目录�?分支；项目会话显示项目名+分支 */
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

/** /s 等文本展示用一�?*/
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
