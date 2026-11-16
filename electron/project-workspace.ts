// ── 建项时准备项目目录：应用内建项和飞书建项共用 ─────────────────────────────
// 应用对代码仓库只做一件事：用户在设置里勾了「克隆副本」的仓库，建项时克隆一份到项目目录，停在选好的分支上。
// 没勾的仓库应用不碰（不检查、不克隆、不切分支），只把仓库信息记进项目，AI 直接用用户本机那份。
// 目录布局：
//   根目录/项目名/<仓库名>   克隆的副本
//   根目录/项目名/workspace  没克隆任何仓库，或克隆了 2 个以上时放在这里当 AI 的工作目录
// 只克隆了 1 个仓库时，那份副本就是 AI 的工作目录。

import { app } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"
import { findRepoProfile, getConfig } from "./config-store"
import { addProjectClone, ensureArtifactDir, isUsableRepoRef, isValidBranchName, removeDirRobust } from "./project-worktree"
import { repoDisplayName } from "../src/shared/project-app-types.js"
import { formatRepoInfoValue, repoInfoKey, resolveWorkBranch } from "../src/shared/project-repo-info.js"
import { listProjects } from "../src/shared/project-store.js"
import { isRemoteRepoRef, repoShortName, type Project, type WorkBranchMode } from "../src/shared/project-types.js"

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `p${Date.now().toString(36)}`
}

/** 新建分支没填名字时的默认名：feature/yyMMdd-项目名 */
export function defaultFeatureBranch(name: string): string {
  const d = new Date()
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `feature/${yy}${mm}${dd}-${slugify(name)}`
}

/** 同名项目目录去重：被现有项目占用则追加 -2/-3… */
export function uniqueProjectSlug(name: string): string {
  const base = slugify(name)
  const used = new Set<string>()
  for (const p of listProjects()) {
    const wt = p.worktreePath
    if (!wt) continue
    // 新布局 root/<slug>/<目录> 取父层；老布局 root/<slug> 取本层
    used.add(path.basename(path.dirname(wt)).toLowerCase())
    used.add(path.basename(wt).toLowerCase())
  }
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; i < 100; i++) {
    const cand = `${base}-${i}`
    if (!used.has(cand.toLowerCase())) return cand
  }
  return `${base}-${Date.now().toString(36)}`
}

/** 项目文件夹的存放根目录：设置里配了就用它，没配用应用数据目录下的 claw-projects */
export function projectsRootDir(): string {
  return (getConfig().worktreeRoot || "").trim() || path.join(app.getPath("userData"), "claw-projects")
}

/**
 * 占一个项目目录：不递归地 mkdir，同名已经存在就换个名字再试。
 * 「检查不存在」和「创建」是一步完成的，两个同名项目同时在建时不会拿到同一个目录
 * （否则后到的那个失败清理时，会把先到的那份克隆一起删掉）；磁盘上没人认领的同名旧目录也不会撞上。
 */
export function claimProjectDir(root: string, slug: string): { ok: true; dir: string } | { ok: false; error: string } {
  try {
    fs.mkdirSync(root, { recursive: true })
    for (let i = 0; i < 20; i++) {
      const dir = path.join(root, i === 0 ? slug : `${slug}-${Date.now().toString(36)}${i > 1 ? i : ""}`)
      try {
        fs.mkdirSync(dir)
        return { ok: true, dir }
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e
      }
    }
    return { ok: false, error: `无法创建项目目录：「${slug}」的同名目录太多` }
  } catch (e: unknown) {
    return { ok: false, error: `无法创建项目目录：${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 确认项目的工作目录还在，并备好成果目录（进入项目会话、点步骤、拉起 Agent 前都先过这一关）。
 * 应用不再碰项目里的 git（不重新克隆、不切分支、不同步远程）：
 * - 用户自己选的文件夹、克隆下来的仓库副本不见了，说清楚是什么问题，不悄悄新建一个空目录冒充；
 * - 只有「没克隆任何仓库」时建的空 workspace 目录被误删，才原样重建（里面本来就什么都没有）。
 */
export async function ensureProjectDir(project: Pick<Project, "worktreePath" | "externalWorkspace">): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = project.worktreePath
  if (!dir) return { ok: true }
  if (!fs.existsSync(dir)) {
    if (project.externalWorkspace || path.basename(dir) !== "workspace") {
      return { ok: false, error: `项目${project.externalWorkspace ? "文件夹" : "目录"}不见了：${dir}（被移动或删除了？）` }
    }
    try { fs.mkdirSync(dir, { recursive: true }) } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : "无法创建项目目录" }
    }
  }
  await ensureArtifactDir(dir)
  return { ok: true }
}

export interface WorkspaceRepo {
  /** 本地仓库目录或远程地址 */
  repoPath: string
  baseBranch: string
  testBranch?: string
  developBranch?: string
}

export interface PrepareWorkspaceInput {
  name: string
  /** 要记进项目的代码仓库（可以一个都没有） */
  repos: WorkspaceRepo[]
  /** 克隆的副本停在哪个分支 */
  workBranch: WorkBranchMode
  /** 工作分支是「新建分支」时的分支名；空串按默认规则生成 */
  featureBranch?: string
  /** 项目目录存放根；不给用设置里的 */
  root?: string
}

export type PreparedWorkspace =
  | {
    ok: true
    /** AI 的工作目录（落到项目的 worktreePath） */
    cwd: string
    /** 要并进项目信息的代码仓库那几行 */
    metadata: Record<string, string>
    /** 实际克隆了几个仓库 */
    cloned: number
    /** 后面落盘失败时用来收拾：整个项目目录都是这次新建的，一并删掉 */
    undo: () => Promise<void>
  }
  | { ok: false; error: string }

/** 这个仓库要不要克隆：设置里的「克隆副本」没取消勾选就克隆；远程地址本机没有副本可用，一律克隆 */
export function shouldCloneRepo(repoPath: string): boolean {
  return isRemoteRepoRef(repoPath) || findRepoProfile(repoPath)?.clone !== false
}

/**
 * 建项目目录：克隆要克隆的仓库、停在选好的分支上、备好成果目录，并生成项目信息里的仓库行。
 * 任何一步失败都把已经建好的整个清掉再报错，不留半成品。
 */
export async function prepareProjectWorkspace(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
  const root = (input.root ?? "").trim() || projectsRootDir()
  const mode = input.workBranch
  const featureBranch = mode === "new" ? (input.featureBranch ?? "").trim() || defaultFeatureBranch(input.name) : ""

  const items = input.repos.map((r) => {
    const known = findRepoProfile(r.repoPath)
    return {
      repo: {
        repoPath: r.repoPath,
        baseBranch: r.baseBranch.trim(),
        // 设置里配过测试/开发分支的带到项目里（研发流程要用）
        testBranch: r.testBranch?.trim() || known?.testBranch || undefined,
        developBranch: r.developBranch?.trim() || known?.developBranch || undefined,
      },
      clone: shouldCloneRepo(r.repoPath),
    }
  })

  // 只检查要克隆的：没勾克隆的仓库应用不碰
  const cloning = items.filter((i) => i.clone)
  if (cloning.length) {
    if (mode === "new" && !(await isValidBranchName(featureBranch))) {
      return { ok: false, error: `新建的分支名不合法：${featureBranch}（不能有空格，也不能以 - 开头）` }
    }
    for (const { repo } of cloning) {
      const label = repoDisplayName(repo.repoPath)
      const target = resolveWorkBranch(mode, repo, featureBranch)
      for (const [what, name] of [["基线分支", repo.baseBranch], ["工作分支", target]] as const) {
        if (name && !(await isValidBranchName(name))) return { ok: false, error: `「${label}」的${what}名不合法：${name}` }
      }
      if (!(await isUsableRepoRef(repo.repoPath))) {
        return { ok: false, error: `「${label}」不是可用的仓库：本地要选 git 仓库的根目录，远程要 http(s)、ssh 或 git@ 开头的地址（${repo.repoPath}）` }
      }
    }
  }

  const claimed = claimProjectDir(root, uniqueProjectSlug(input.name))
  if (!claimed.ok) return { ok: false, error: claimed.error }
  const slugDir = claimed.dir
  const undo = () => removeDirRobust(slugDir)

  // 仓库在项目目录里的短名；同名（不同位置的两个 foo）加序号，项目信息里也用同一个名字
  const used = new Set<string>()
  const names = items.map(({ repo }) => {
    let short = repoShortName(repo.repoPath)
    for (let i = 2; used.has(short.toLowerCase()); i++) short = `${repoShortName(repo.repoPath)}-${i}`
    used.add(short.toLowerCase())
    return short
  })

  const metadata: Record<string, string> = {}
  const multi = items.length > 1
  let cloned = 0
  let onlyClone = ""
  for (let i = 0; i < items.length; i++) {
    const { repo, clone } = items[i]
    if (!clone) {
      metadata[repoInfoKey(names[i], multi)] = formatRepoInfoValue({
        dir: repo.repoPath,
        baseBranch: repo.baseBranch,
        testBranch: repo.testBranch,
        developBranch: repo.developBranch,
      })
      continue
    }
    const dir = path.join(slugDir, names[i])
    const target = resolveWorkBranch(mode, repo, featureBranch)
    const res = await addProjectClone({
      repoPath: repo.repoPath,
      worktreePath: dir,
      baseBranch: repo.baseBranch,
      checkout: mode === "new" ? { create: target } : { existing: target },
    })
    if (!res.ok) {
      await undo()
      return { ok: false, error: `「${repoDisplayName(repo.repoPath)}」${res.error ?? "克隆失败"}` }
    }
    cloned++
    onlyClone = dir
    metadata[repoInfoKey(names[i], multi)] = formatRepoInfoValue({
      dir,
      workBranch: target,
      baseBranch: repo.baseBranch,
      testBranch: repo.testBranch,
      developBranch: repo.developBranch,
    })
  }

  let cwd = onlyClone
  try {
    if (cloned !== 1) {
      cwd = path.join(slugDir, "workspace")
      fs.mkdirSync(cwd, { recursive: true })
    }
    await ensureArtifactDir(cwd)
  } catch (e: unknown) {
    await undo()
    return { ok: false, error: `无法准备项目目录：${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, cwd, metadata, cloned, undo }
}
