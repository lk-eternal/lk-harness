import * as fs from "node:fs"
import * as path from "node:path"

/**
 * 不起 git 进程，直接从 .git 目录读出当前分支。
 *
 * 会话列表每隔几秒刷新一次，每个会话的工作目录都要问分支；起一个 git 进程在 Windows 上实测要 200ms 左右，
 * 而且 spawnSync 会把主进程卡住那么久。读 HEAD 文件只要零点几毫秒。
 *
 * 只回答「能确定」的情况：
 * - branch：HEAD 指向一个确实存在的 refs/heads/<name>
 * - none：这里不在任何 git 仓库里
 * 其余（游离 HEAD、还没有提交的分支、reftable、裸仓库、设了 GIT_DIR……）返回 unknown，由调用方回落到真正的 git 命令，
 * 这样输出和以前完全一致，不会因为自己解析得不严而显示错的分支。
 */
export type GitHeadResult =
  | { kind: "branch"; name: string }
  | { kind: "none" }
  | { kind: "unknown" }

const HEADS_PREFIX = "refs/heads/"

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** 从 dir 往上找 .git：目录就是 git 目录；文件（worktree / 子模块）里写着 `gitdir: <路径>` */
function findGitDir(startDir: string): { gitDir: string } | "none" | "unknown" {
  let cur = path.resolve(startDir)
  for (;;) {
    const dotGit = path.join(cur, ".git")
    let st: fs.Stats | undefined
    try {
      st = fs.statSync(dotGit)
    } catch {
      st = undefined
    }
    if (st?.isDirectory()) return { gitDir: dotGit }
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "")
      if (!m) return "unknown"
      return { gitDir: path.resolve(cur, m[1]) }
    }
    const parent = path.dirname(cur)
    if (parent === cur) return "none"
    cur = parent
  }
}

/** worktree 的 refs 在主仓库的 git 目录里（gitDir/commondir 指过去），普通仓库就是 gitDir 自己 */
function commonDirOf(gitDir: string): string {
  const rel = readText(path.join(gitDir, "commondir"))?.trim()
  return rel ? path.resolve(gitDir, rel) : gitDir
}

/** refs/heads/<name> 是否存在：松散文件，或写在 packed-refs 里 */
function branchRefExists(commonDir: string, name: string): boolean {
  try {
    if (fs.statSync(path.join(commonDir, ...HEADS_PREFIX.split("/"), ...name.split("/"))).isFile()) return true
  } catch { /* 不是松散引用，继续看 packed-refs */ }
  const packed = readText(path.join(commonDir, "packed-refs"))
  if (!packed) return false
  const ref = HEADS_PREFIX + name
  for (const line of packed.split("\n")) {
    // 形如 `<sha> refs/heads/main`；`#` 开头是文件头，`^` 开头是上一条 tag 的剥离值
    if (line.length > 41 && line.charCodeAt(0) !== 35 && line.charCodeAt(0) !== 94 && line.slice(41).trim() === ref) return true
  }
  return false
}

export function readGitHead(dir: string): GitHeadResult {
  // 设了这些环境变量，git 找仓库的规则就不是「往上找 .git」了，别自己猜
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return { kind: "unknown" }
  try {
    // 目录不存在时 git -C 直接失败（没有分支）；别因为往上找到了某个祖先的仓库而误报
    if (!fs.statSync(dir).isDirectory()) return { kind: "none" }
  } catch {
    return { kind: "none" }
  }
  const found = findGitDir(dir)
  if (found === "unknown") return { kind: "unknown" }
  if (found === "none") {
    // 目录本身就是裸仓库的话（有 HEAD 和 objects），这里读不对，交给 git
    const looksBare = fs.existsSync(path.join(dir, "HEAD")) && fs.existsSync(path.join(dir, "objects"))
    return looksBare ? { kind: "unknown" } : { kind: "none" }
  }
  const head = readText(path.join(found.gitDir, "HEAD"))?.trim()
  if (!head) return { kind: "unknown" }
  const m = /^ref:\s*(.+)$/.exec(head)
  if (!m || !m[1].startsWith(HEADS_PREFIX)) return { kind: "unknown" }
  const name = m[1].slice(HEADS_PREFIX.length)
  if (!name) return { kind: "unknown" }
  // 指向的分支还不存在（没有提交的新仓库）/ reftable：git 会报错或另有说法，交给它
  return branchRefExists(commonDirOf(found.gitDir), name) ? { kind: "branch", name } : { kind: "unknown" }
}
