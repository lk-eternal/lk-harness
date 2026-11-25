import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { readGitHead } from "./git-head.js"
import { projectIdFromSessionKey, type Project } from "./project-types.js"

export type SessionCardTitle = { title: string; subtitle?: string }

/**
 * 当前分支。先直接读 .git/HEAD（零点几毫秒，不起进程）；
 * 读不确定的情况（游离 HEAD、还没有提交、裸仓库……）才回落到真正的 git 命令，结果和以前一致。
 */
export function readGitBranch(dir: string): string | undefined {
  const head = readGitHead(dir)
  if (head.kind === "branch") return head.name
  if (head.kind === "none") return undefined
  return readGitBranchViaGit(dir)
}

/** 起 git 进程取分支：Windows 上实测每次约 200ms，而且是同步的（卡主进程），只作兜底 */
export function readGitBranchViaGit(dir: string): string | undefined {
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

const BRANCH_CACHE_TTL_MS = 30_000
const branchCache = new Map<string, { at: number; branch: string | undefined }>()

/** 首页轮询专用：分支名短时缓存，避免每轮为每个会话同步起 git 进程；命令回复等要即时值的场景仍用 readGitBranch */
export function readGitBranchCached(dir: string): string | undefined {
  const now = Date.now()
  const hit = branchCache.get(dir)
  if (hit && now - hit.at < BRANCH_CACHE_TTL_MS) return hit.branch
  const branch = readGitBranch(dir)
  branchCache.set(dir, { at: now, branch })
  return branch
}

/** 切换分支后清掉缓存：不清的话各处要等 30 秒才显示新分支（同一个仓库可能用不同写法的路径缓存了好几份，整体清最稳） */
export function clearGitBranchCache(): void {
  branchCache.clear()
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
    // 项目目录本身是 git 仓库时（只克隆了一个仓库）显示它当前所在的分支；否则不显示
    const branch = p?.worktreePath ? readGitBranch(p.worktreePath) : undefined
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

