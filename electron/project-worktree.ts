import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isRemoteRepoRef } from "../src/shared/project-types.js"
import { removeNoFollow } from "../src/shared/safe-remove.js"

export { isRemoteRepoRef }

export interface CloneAddInput {
  /** 本地主仓路径（读远程地址 + 加速克隆）或远程仓库地址 */
  repoPath: string
  /** AI 工作目录（独立 clone，与用户主仓完全隔离） */
  worktreePath: string
  featureBranch: string
  baseBranch: string
  fetch?: boolean
}

export interface WorktreeResult {
  ok: boolean
  error?: string
}

export interface WorktreeRepoRef {
  repoPath: string
  worktreePath: string
  baseBranch: string
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
  /** 超时被杀掉的 */
  timedOut?: boolean
}

/** 连带子进程一起杀：git 克隆会再起 git-remote-https / ssh，Windows 上只杀 git 本身，它们会留着占住目录 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill())
      return
    } catch { /* 退回下面的 kill */ }
  }
  child.kill()
}

/**
 * 这里没有终端：git 要输入用户名密码时没人能回答，会一直等下去，所以一律让它直接失败（GIT_TERMINAL_PROMPT=0）。
 * 图形的凭据管理器（Windows 的 GCM 弹窗）不受这个影响，用户还能在弹窗里登录，超时兜底。
 */
function runGit(cwd: string, args: string[], timeoutMs?: number, extraEnv?: Record<string, string>): Promise<GitResult> {
  const withSafe = ["-c", "safe.directory=*", ...args]
  return new Promise((resolve) => {
    const child = spawn("git", withSafe, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv } })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result: GitResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    child.stdout?.setEncoding("utf-8").on("data", (c) => { stdout += c })
    child.stderr?.setEncoding("utf-8").on("data", (c) => { stderr += c })
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs != null) {
      timer = setTimeout(() => {
        killTree(child)
        finish({ ok: false, stdout: stdout.trim(), stderr: stderr.trim() || "timeout", code: 1, timedOut: true })
      }, timeoutMs)
    }
    child.on("error", (err) => {
      finish({ ok: false, stdout: stdout.trim(), stderr: String(err.message || err), code: 1 })
    })
    child.on("close", (code) => {
      finish({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 })
    })
  })
}

/**
 * 删一个刚被 git 用过的目录（克隆失败后的清理）。两个 Windows 上的坑：
 * 1. git 子进程刚退出，目录可能还短暂被占着，rmSync 带 force 也会悄悄没删成（不抛错，它自带的重试也不会触发）；
 * 2. 部分 Node 24 版本（实测 24.11.1）的 rmSync / rmdirSync 对含中文的路径会静默什么都不删，
 *    而项目名常常就是中文——异步的 fs.promises.rm 没这个问题。
 * 所以这里用异步删，并且按「目录还在不在」判断，没删掉就等一下再删。
 * 始终不抛：清理是尽力而为，不能掩盖真正的失败原因。
 */
export async function removeDirRobust(dir: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try { await fs.promises.rm(dir, { recursive: true, force: true }) } catch { /* 下面按目录还在不在判断 */ }
    if (!fs.existsSync(dir)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
  }
}

/** 克隆最多等多久：大仓库、慢网络要给够时间，但不能无限等（要登录又没人能回答时会一直卡着） */
const CLONE_TIMEOUT_MS = 10 * 60_000

/**
 * 远程仓库走 ssh 时，没有可用密钥或没确认过主机指纹，ssh 会等人输入——这里没有终端，永远等不到。
 * 让它直接失败并说原因（BatchMode）。用户自己配了 ssh 命令（环境变量或 core.sshCommand）就不动它。
 */
async function sshBatchEnv(cwd: string): Promise<Record<string, string> | undefined> {
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return undefined
  const cfg = await runGit(cwd, ["config", "--get", "core.sshCommand"], 10_000)
  if (cfg.ok && cfg.stdout) return undefined
  return { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }
}

function resolveReal(p: string): string {
  try {
    return fs.realpathSync.native(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
}

export async function isGitRepoRoot(repoPath: string): Promise<boolean> {
  if (!repoPath || !fs.existsSync(repoPath)) return false
  const r = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"])
  if (!r.ok || r.stdout !== "true") return false
  const top = await runGit(repoPath, ["rev-parse", "--show-toplevel"])
  if (!top.ok) return false
  return resolveReal(top.stdout) === resolveReal(repoPath)
}

/** 主仓引用是否可用作克隆源（远程地址直接放行，本地路径须为 git 根） */
export async function isUsableRepoRef(repoPath: string): Promise<boolean> {
  return isRemoteRepoRef(repoPath) || (await isGitRepoRoot(repoPath))
}

/**
 * 分支名是否合法：交给 git 判断，和之后真正建分支时是同一套规则。
 * 以 - 开头的一律不要：后面拼进 git 命令行会被当成选项。
 */
export async function isValidBranchName(name: string): Promise<boolean> {
  const n = (name ?? "").trim()
  if (!n || n.startsWith("-")) return false
  // 不依赖当前目录是不是仓库
  const r = await runGit(os.tmpdir(), ["check-ref-format", "--branch", n], 10_000)
  return r.ok
}

export interface LocalRepoInfo {
  /** 仓库的默认基线分支：origin 的默认分支，没有就用当前分支 */
  defaultBranch: string
  /** 本地和 origin 上的分支名（去重排序，最多 200 个），给输入框做提示 */
  branches: string[]
}

/** 看一个本地文件夹是不是 git 仓库根目录，是的话给出默认基线分支和分支列表；失败返回一句人话 */
export async function inspectLocalRepo(repoPath: string): Promise<{ ok: true; info: LocalRepoInfo } | { ok: false; error: string }> {
  const dir = (repoPath ?? "").trim()
  if (!dir || !path.isAbsolute(dir)) return { ok: false, error: "请选择一个有效的文件夹" }
  if (!fs.existsSync(dir)) return { ok: false, error: `文件夹不存在：${dir}` }
  if (!(await isGitRepoRoot(dir))) {
    return { ok: false, error: "这不是 git 仓库的根目录（里面要直接有 .git），请选仓库最外面那一层" }
  }
  const refs = await runGit(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"], 15_000)
  const names = new Set<string>()
  if (refs.ok) {
    for (const line of refs.stdout.split(/\r?\n/)) {
      const n = line.trim().replace(/^origin\//, "")
      if (n && n !== "origin" && n !== "HEAD") names.add(n)
    }
  }
  let defaultBranch = ""
  const head = await runGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], 10_000)
  if (head.ok) defaultBranch = head.stdout.trim().replace(/^origin\//, "")
  if (!defaultBranch) {
    const cur = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"], 10_000)
    if (cur.ok && cur.stdout.trim() && cur.stdout.trim() !== "HEAD") defaultBranch = cur.stdout.trim()
  }
  if (!defaultBranch) defaultBranch = names.has("main") ? "main" : names.has("master") ? "master" : "main"
  return { ok: true, info: { defaultBranch, branches: [...names].sort().slice(0, 200) } }
}

/**
 * 独立 clone 创建 AI 工作目录：与用户主仓无 worktree 关联，同一分支双方可同时检出。
 * 本地主仓作克隆源加速（硬链接秒级），origin 指回真实远程；AI 提交 push 后用户主库 pull 即可。
 */
export async function addProjectClone(input: CloneAddInput): Promise<WorktreeResult> {
  const { repoPath, worktreePath, featureBranch, baseBranch } = input
  if (!featureBranch.trim() || !baseBranch.trim()) {
    return { ok: false, error: "基线分支与 feature 分支不能为空" }
  }
  const remote = isRemoteRepoRef(repoPath)
  if (!remote && !await isGitRepoRoot(repoPath)) {
    return { ok: false, error: `主仓无效（须为 git 根目录或远程地址） ${repoPath}` }
  }
  if (fs.existsSync(worktreePath)) {
    return { ok: false, error: `AI 工作目录已存在  ${worktreePath}` }
  }
  const parent = path.dirname(worktreePath)
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true })

  const fail = async (msg: string): Promise<WorktreeResult> => {
    await removeDirRobust(worktreePath)
    return { ok: false, error: msg }
  }

  // 本地仓作源：先取 origin URL（可能因 ownership 失败，失败则仍尝试本地 clone）
  let originUrl = ""
  if (!remote) {
    const ou = await runGit(repoPath, ["remote", "get-url", "origin"])
    if (ou.ok && ou.stdout) originUrl = ou.stdout.trim()
  }

  // 本地 clone 加速（硬链接）；源有 dubious ownership 时本地 clone 会失败，回退到 origin 远程
  const netEnv = remote || originUrl ? await sshBatchEnv(parent) : undefined
  let clone = await runGit(parent, ["clone", repoPath, worktreePath], CLONE_TIMEOUT_MS, netEnv)
  if (!clone.ok && !clone.timedOut && !remote && originUrl) {
    await removeDirRobust(worktreePath)
    clone = await runGit(parent, ["clone", originUrl, worktreePath], CLONE_TIMEOUT_MS, netEnv)
  }
  if (!clone.ok) {
    if (clone.timedOut) {
      return fail(`git clone 超时（超过 ${CLONE_TIMEOUT_MS / 60_000} 分钟）：仓库太大、网络太慢，或需要登录凭据。可以先在终端里手动 git clone 一次，确认能克隆下来再试`)
    }
    const detail = clone.stderr || clone.stdout
    const ownership = /dubious ownership/i.test(detail)
    // 这里没有终端，git 要输入用户名密码 / ssh 要确认主机指纹时只能直接失败：告诉用户怎么办
    const needLogin = /terminal prompts disabled|could not read (Username|Password)|Authentication failed|Permission denied \(publickey|Host key verification failed/i.test(detail)
    return fail(
      ownership
        ? `git clone 失败（主仓所有者与当前用户不一致，且无法从远程拉取） ${detail}`
        : needLogin
          ? `git clone 失败（需要登录凭据：先在终端里手动 git clone 一次，让 git 记住凭据或确认主机，再回来建项目） ${detail}`
          : `git clone 失败: ${detail}`,
    )
  }

  // 本地源：origin 指回真实远程（本地仓库 origin 则保持指向本地，纯本地仓也能正常协作）
  let hasOrigin = true
  if (!remote) {
    if (originUrl) {
      const set = await runGit(worktreePath, ["remote", "set-url", "origin", originUrl])
      if (!set.ok) return fail(`设置 origin 失败: ${set.stderr || set.stdout}`)
    } else {
      hasOrigin = await isGitRepoRoot(repoPath) // origin 指向本地主仓路径
    }
  }

  if (input.fetch !== false && hasOrigin) {
    const fetch = await runGit(worktreePath, ["fetch", "origin", "--prune"], 60_000, netEnv)
    if (!fetch.ok) return fail(`git fetch 失败: ${fetch.stderr || fetch.stdout}`)
  }

  const co = await checkoutOrCreateFeature(worktreePath, featureBranch, baseBranch)
  if (!co.ok) return fail(co.error || "检出 feature 失败")
  await ensureClawExcluded(worktreePath)
  return { ok: true }
}

/** 检出 feature：远程有→track 检出；本地有→切过去；都没有→从基线新建（不 track 基线，防误推） */
async function checkoutOrCreateFeature(cloneDir: string, featureBranch: string, baseBranch: string): Promise<WorktreeResult> {
  const local = await runGit(cloneDir, ["rev-parse", "--verify", featureBranch])
  if (local.ok) {
    const co = await runGit(cloneDir, ["checkout", featureBranch])
    if (!co.ok) return { ok: false, error: co.stderr || co.stdout }
    await ensureFeatureUpstream(cloneDir, featureBranch)
    return { ok: true }
  }
  const remoteFeat = await runGit(cloneDir, ["rev-parse", "--verify", `origin/${featureBranch}`])
  if (remoteFeat.ok) {
    const co = await runGit(cloneDir, ["checkout", "--track", "-b", featureBranch, `origin/${featureBranch}`])
    if (!co.ok) return { ok: false, error: co.stderr || co.stdout }
    return { ok: true }
  }
  const baseOrigin = await runGit(cloneDir, ["rev-parse", "--verify", `origin/${baseBranch}`])
  const baseLocal = await runGit(cloneDir, ["rev-parse", "--verify", baseBranch])
  const baseRef = baseOrigin.ok ? `origin/${baseBranch}` : (baseLocal.ok ? baseBranch : "")
  if (!baseRef) return { ok: false, error: `找不到基线分支 ${baseBranch}（本地与 origin 均无）` }
  const co = await runGit(cloneDir, ["checkout", "--no-track", "-b", featureBranch, baseRef])
  if (!co.ok) return { ok: false, error: co.stderr || co.stdout }
  return { ok: true }
}

/** feature 的 upstream 只允许指向 origin 同名分支：有则对齐，无则清掉（防止跟踪生产基线导致误推） */
async function ensureFeatureUpstream(cloneDir: string, featureBranch: string): Promise<void> {
  const remote = await runGit(cloneDir, ["rev-parse", "--verify", `origin/${featureBranch}`])
  if (remote.ok) {
    await runGit(cloneDir, ["branch", `--set-upstream-to=origin/${featureBranch}`, featureBranch])
  } else {
    await runGit(cloneDir, ["branch", "--unset-upstream"])
  }
}

/** 确保工作目录检出 feature：独立 clone 无分支互斥；目录存在但分支缺失时从基线新建 */
async function ensureFeatureInClone(worktreePath: string, featureBranch: string, baseBranch: string): Promise<WorktreeResult> {
  if (!fs.existsSync(worktreePath)) {
    return { ok: false, error: `AI 工作目录不存在  ${worktreePath}` }
  }
  const cur = await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (cur.ok && cur.stdout === featureBranch) return { ok: true }
  const co = await runGit(worktreePath, ["checkout", featureBranch])
  if (co.ok) return { ok: true }
  // 目录已存在但 feature 不在本地/远程：fetch 后从基线 checkout -b，保证 clone 不删目录
  await runGit(worktreePath, ["fetch", "origin", "--prune"], 60_000)
  const created = await checkoutOrCreateFeature(worktreePath, featureBranch, baseBranch)
  if (!created.ok) return created
  await ensureClawExcluded(worktreePath)
  return { ok: true }
}

/** 确保 AI 工作目录存在且检出 feature：缺失时自动重建（建项失败或被手动删除的懒修复） */
export async function ensureCheckouts(repos: WorktreeRepoRef[], featureBranch: string): Promise<WorktreeResult> {
  for (const r of repos) {
    const res = fs.existsSync(r.worktreePath)
      ? await ensureFeatureInClone(r.worktreePath, featureBranch, r.baseBranch)
      : await addProjectClone({ repoPath: r.repoPath, worktreePath: r.worktreePath, featureBranch, baseBranch: r.baseBranch })
    if (!res.ok) return { ok: false, error: `${path.basename(r.worktreePath)}: ${res.error}` }
  }
  return { ok: true }
}

/** fetch + 快进同步远程 feature 新提交；失败不阻塞（离线可用本地代码），返回给用户的提示语 */
export async function syncCheckout(worktreePath: string, featureBranch: string): Promise<{ note?: string }> {
  if (!fs.existsSync(worktreePath)) return {}
  const name = path.basename(worktreePath)
  const fetch = await runGit(worktreePath, ["fetch", "origin", "--prune"], 30_000)
  if (!fetch.ok) return { note: `⚠️ ${name}: 拉取远程失败（${(fetch.stderr || "超时").slice(0, 100)}），暂用本地代码` }
  const remote = await runGit(worktreePath, ["rev-parse", "--verify", `origin/${featureBranch}`])
  if (!remote.ok) return {}
  const behind = await runGit(worktreePath, ["rev-list", "--count", `HEAD..origin/${featureBranch}`])
  const n = parseInt(behind.stdout, 10)
  if (!behind.ok || isNaN(n) || n === 0) return {}
  const ff = await runGit(worktreePath, ["merge", "--ff-only", `origin/${featureBranch}`])
  if (ff.ok) return { note: `⬇️ ${name}: 已同步远程 ${n} 个新提交` }
  return { note: `⚠️ ${name}: 远程有 ${n} 个新提交但与本地有分歧，未自动合并（可在项目会话中 AI 处理）` }
}

/** 确保工作目录检出 feature（独立 clone 无分支互斥；存量 worktree 项目被主仓占用时会失败并透出 git 原因） */
export async function checkoutFeature(worktreePath: string, featureBranch: string): Promise<WorktreeResult> {
  if (!fs.existsSync(worktreePath)) {
    return { ok: false, error: `AI 工作目录不存在  ${worktreePath}` }
  }
  const cur = await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (cur.ok && cur.stdout === featureBranch) return { ok: true }
  const co = await runGit(worktreePath, ["checkout", featureBranch])
  if (co.ok) return { ok: true }
  return { ok: false, error: co.stderr || co.stdout }
}

/** 删除 AI 工作目录：兼容存量 worktree 项目（先 worktree remove，兜底直接删目录，最后 prune 元数据） */
export async function removeProjectWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const localRepo = !isRemoteRepoRef(repoPath) && fs.existsSync(repoPath)
  try {
    if (localRepo) await runGit(repoPath, ["worktree", "remove", "--force", worktreePath])
  } catch { /* ignore */ }
  // 不能直接 fs.rmSync：Electron 的 Node 里它会顺着目录里的链接把目标也删了（见 shared/safe-remove.ts）
  try {
    if (fs.existsSync(worktreePath)) await removeNoFollow(worktreePath)
  } catch { /* ignore */ }
  try {
    if (localRepo) await runGit(repoPath, ["worktree", "prune"])
  } catch { /* ignore */ }
}

export async function ensureArtifactDir(worktreePath: string): Promise<string> {
  const dir = path.join(worktreePath, ".lk-harness", "artifacts")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  await ensureClawExcluded(worktreePath)
  return dir
}

/** 将 .lk-harness/ 写进仓库本地 exclude（不动用户 .gitignore）：产物不进 git status、不见于 IDE 未版本列表 */
export async function ensureClawExcluded(worktreePath: string): Promise<void> {
  try {
    const gp = await runGit(worktreePath, ["rev-parse", "--git-path", "info/exclude"])
    if (!gp.ok || !gp.stdout) return
    const excludePath = path.isAbsolute(gp.stdout) ? gp.stdout : path.join(worktreePath, gp.stdout)
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : ""
    if (existing.split(/\r?\n/).some((l) => l.trim() === ".lk-harness/")) return
    fs.mkdirSync(path.dirname(excludePath), { recursive: true })
    fs.appendFileSync(excludePath, `${existing.endsWith("\n") || !existing ? "" : "\n"}.lk-harness/\n`, "utf-8")
  } catch { /* best-effort */ }
}

/** porcelain 状态行（剔除 .lk-harness 产物目录）；查询失败按空处理 */
async function dirtyLines(worktreePath: string): Promise<string[]> {
  if (!fs.existsSync(worktreePath)) return []
  const st = await runGit(worktreePath, ["status", "--porcelain"])
  if (!st.ok || !st.stdout) return []
  return st.stdout.split("\n").filter(Boolean)
    .filter((l) => !l.slice(3).trim().replace(/^"|"$/g, "").startsWith(".lk-harness"))
}

/** 未提交改动条数（含未跟踪；不含 .lk-harness 产物） */
export async function worktreeDirtyCount(worktreePath: string): Promise<number> {
  return (await dirtyLines(worktreePath)).length
}

/** 未推送到 origin/feature 的提交数；无 upstream/查询失败返回 -1（未知） */
export async function unpushedCount(worktreePath: string, featureBranch: string): Promise<number> {
  if (!fs.existsSync(worktreePath)) return -1
  const r = await runGit(worktreePath, ["rev-list", "--count", `origin/${featureBranch}..HEAD`])
  if (!r.ok) return -1
  const n = parseInt(r.stdout, 10)
  return isNaN(n) ? -1 : n
}

