// ── 项目里的「代码仓库」信息 ──────────────────────────────────────────────
// 仓库、分支对 AI 来说只是项目信息的一部分：和「对象」「截止时间」一样记在项目的 metadata 里，
// 用户可以在项目详情里直接改，AI 也可以用 project_update 补。不再有专门的 repoPath / featureBranch / repos 字段。

import type { WorkBranchMode } from "./work-branch-mode.js"

/** 项目信息里代码仓库那几行的键：一个仓库就叫它，多个仓库加「 · 仓库名」 */
export const REPO_INFO_KEY = "代码仓库"

const REPO_INFO_SEP = " · "

/** 某个仓库在项目信息里的键；multi=true（项目接了多个仓库）时带上仓库名区分 */
export function repoInfoKey(name: string, multi: boolean): string {
  return multi ? `${REPO_INFO_KEY}${REPO_INFO_SEP}${name}` : REPO_INFO_KEY
}

export function isRepoInfoKey(key: string): boolean {
  return key === REPO_INFO_KEY || key.startsWith(REPO_INFO_KEY + REPO_INFO_SEP)
}

/** 项目里有没有记代码仓库（决定会话里要不要带 Git 基本原则） */
export function projectHasRepoInfo(p: { metadata?: Record<string, string> }): boolean {
  return Object.entries(p.metadata ?? {}).some(([k, v]) => isRepoInfoKey(k) && v.trim() !== "")
}

export interface RepoInfoParts {
  /** AI 实际操作的目录：克隆了就是项目目录里的副本，没克隆就是用户自己的仓库目录（或远程地址） */
  dir: string
  /** 克隆副本当前所在的分支（没克隆的仓库不写，应用不会去碰它） */
  workBranch?: string
  baseBranch?: string
  testBranch?: string
  developBranch?: string
}

/** 仓库信息写成一行人和 AI 都读得懂的话：`目录（工作分支 x；基线分支 y；测试分支 z；开发分支 w）`，空的分支不写 */
export function formatRepoInfoValue(r: RepoInfoParts): string {
  const bits = [
    r.workBranch?.trim() ? `工作分支 ${r.workBranch.trim()}` : "",
    r.baseBranch?.trim() ? `基线分支 ${r.baseBranch.trim()}` : "",
    r.testBranch?.trim() ? `测试分支 ${r.testBranch.trim()}` : "",
    r.developBranch?.trim() ? `开发分支 ${r.developBranch.trim()}` : "",
  ].filter(Boolean)
  return bits.length ? `${r.dir}（${bits.join("；")}）` : r.dir
}

/**
 * 克隆副本要停在哪个分支：
 * - 新建分支：用 featureBranch（调用方已经把「没填」换成默认名）；
 * - 基线 / 测试 / 开发分支：用对应的分支，没配测试/开发分支就退到基线分支；
 * - 基线也没配返回空串，意思是不切分支，停在克隆下来的默认分支。
 */
export function resolveWorkBranch(
  mode: WorkBranchMode,
  r: { baseBranch?: string; testBranch?: string; developBranch?: string },
  featureBranch: string,
): string {
  const base = (r.baseBranch ?? "").trim()
  if (mode === "new") return featureBranch.trim()
  if (mode === "test") return (r.testBranch ?? "").trim() || base
  if (mode === "develop") return (r.developBranch ?? "").trim() || base
  return base
}

/** 旧版项目里和代码仓库有关的字段（现在都折进项目信息了） */
export interface LegacyRepoFields {
  repoPath?: string
  baseBranch?: string
  featureBranch?: string
  worktreePath?: string
  repos?: {
    repoPath?: string
    baseBranch?: string
    testBranch?: string
    developBranch?: string
    worktreePath?: string
  }[]
  workspaceType?: string
}

const LEGACY_KEYS = ["repoPath", "baseBranch", "featureBranch", "repos", "workspaceType"] as const

/** 目录最后一段，当仓库的短名 */
function lastSegment(p: string): string {
  const norm = (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "")
  return norm.split("/").pop() || "repo"
}

/**
 * 旧版项目文件 → 新版：把仓库、分支折成项目信息里的几行，去掉旧字段。
 * - 没有旧字段（新版文件或纯会话项目）原样返回，同一个对象；
 * - 已经有同名的项目信息（用户或 AI 自己写过）不覆盖；
 * - 重复调用结果一样（旧字段没了就什么都不做）。
 */
export function migrateLegacyRepoFields<T extends LegacyRepoFields & { metadata?: Record<string, string> }>(
  raw: T,
): Omit<T, (typeof LEGACY_KEYS)[number]> & { metadata?: Record<string, string> } {
  const has = LEGACY_KEYS.some((k) => (raw as Record<string, unknown>)[k] !== undefined)
  if (!has) return raw as never
  const { repoPath, baseBranch, featureBranch, repos, workspaceType: _legacyType, ...rest } = raw as T & LegacyRepoFields

  const list = repos?.length
    ? repos
    : [{ repoPath, baseBranch, worktreePath: raw.worktreePath }]
  const real = list.filter((r) => (r.repoPath ?? "").trim())
  const feature = (featureBranch ?? "").trim()
  const metadata = { ...(raw.metadata ?? {}) }
  const used = new Set<string>()
  real.forEach((r) => {
    let name = lastSegment(r.repoPath!)
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${lastSegment(r.repoPath!)}-${n}`
    used.add(name.toLowerCase())
    const key = repoInfoKey(name, real.length > 1)
    if (metadata[key] !== undefined) return
    metadata[key] = formatRepoInfoValue({
      dir: (r.worktreePath ?? "").trim() || r.repoPath!.trim(),
      workBranch: feature,
      baseBranch: r.baseBranch,
      testBranch: r.testBranch,
      developBranch: r.developBranch,
    })
  })
  const next = { ...rest } as Record<string, unknown>
  if (Object.keys(metadata).length) next.metadata = metadata
  return next as never
}
