// ── 工作目录的 git 分支：读列表、切换（执行 git 的那一层）─────────────────
// 规则（怎么解析、报错怎么说）在 src/shared/git-branch.ts。这里异步起 git 进程，不阻塞主进程：
// 大仓库的 status、checkout 可能要好几秒。参数一律走 execFile 的数组，不经过 shell。

import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  IN_PROGRESS_MARKERS,
  describeSwitchFailure,
  inProgressReason,
  parseBranchRefs,
  parseDirtyCount,
  type BranchOption,
  type BranchTarget,
} from "../src/shared/git-branch"

interface GitRun {
  ok: boolean
  stdout: string
  stderr: string
}

const READ_TIMEOUT_MS = 15_000
const SWITCH_TIMEOUT_MS = 120_000
/** 分支列表最多读这么多个引用；超了说明仓库分支非常多，只列最近有提交的 */
const MAX_REFS = 2000

function runGit(dir: string, args: string[], opts: { timeout: number; readOnly?: boolean }): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", "-C", dir, ...args],
      {
        encoding: "utf8",
        timeout: opts.timeout,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          // 报错固定用英文：describeSwitchFailure 按英文原文认；不让 git 弹账号密码输入
          LC_ALL: "C",
          LANGUAGE: "C",
          GIT_TERMINAL_PROMPT: "0",
          // 只读命令不去抢 index.lock，免得和 Agent 正在跑的 git 互相卡住
          ...(opts.readOnly ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
        },
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, stdout, stderr })
          return
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean }
        const timedOut = e.killed === true
        resolve({
          ok: false,
          stdout: stdout ?? "",
          stderr: timedOut ? "timed out" : (stderr || e.message || "").toString(),
        })
      },
    )
  })
}

export interface BranchState {
  /** 仓库根目录（`git rev-parse --show-toplevel`，正斜杠） */
  toplevel: string
  current: string
  detached: boolean
  branches: BranchOption[]
  dirty: number
  truncated: boolean
  /** git 正在做一件做到一半的事（rebase、合并…）：给用户看的原因；没有则缺省 */
  inProgress?: string
}

export type BranchStateResult = ({ ok: true } & BranchState) | { ok: false; error: string }

const REF_FORMAT = "%(refname)%09%(committerdate:unix)%09%(worktreepath)"
const REF_FORMAT_OLD_GIT = "%(refname)%09%(committerdate:unix)"

async function readRefs(dir: string): Promise<GitRun> {
  const args = (format: string) => [
    "for-each-ref", "--sort=-committerdate", `--count=${MAX_REFS}`, `--format=${format}`, "refs/heads", "refs/remotes",
  ]
  const r = await runGit(dir, args(REF_FORMAT), { timeout: READ_TIMEOUT_MS, readOnly: true })
  // 老版本 git 没有 worktreepath：退回不带它（分支在别处检出时就只能等 git 自己拒绝）
  if (!r.ok && /unknown field name/i.test(r.stderr)) return runGit(dir, args(REF_FORMAT_OLD_GIT), { timeout: READ_TIMEOUT_MS, readOnly: true })
  return r
}

/** git 正在做的、做到一半的事：看 .git 下对应的标记文件在不在 */
async function readInProgress(dir: string): Promise<string | undefined> {
  const args = ["rev-parse", ...IN_PROGRESS_MARKERS.flatMap((m) => ["--git-path", m])]
  const r = await runGit(dir, args, { timeout: READ_TIMEOUT_MS, readOnly: true })
  if (!r.ok) return undefined
  const paths = r.stdout.split(/\r?\n/).filter(Boolean)
  const hit = IN_PROGRESS_MARKERS.findIndex((_, i) => paths[i] && fs.existsSync(path.resolve(dir, paths[i])))
  return hit >= 0 ? inProgressReason(IN_PROGRESS_MARKERS[hit]) : undefined
}

/** 读工作目录当前的分支状态：当前分支、全部分支、有多少已跟踪文件有改动 */
export async function readBranchState(dir: string): Promise<BranchStateResult> {
  const head = await runGit(dir, ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], { timeout: READ_TIMEOUT_MS, readOnly: true })
  if (!head.ok) return { ok: false, error: describeSwitchFailure(head.stderr) }
  const [toplevel, abbrev] = head.stdout.split(/\r?\n/).map((l) => l.trim())
  if (!toplevel || !abbrev) return { ok: false, error: "读不到当前分支" }
  const detached = abbrev === "HEAD"

  const [refs, status, sha, inProgress] = await Promise.all([
    readRefs(dir),
    runGit(dir, ["status", "--porcelain", "-uno"], { timeout: READ_TIMEOUT_MS, readOnly: true }),
    detached ? runGit(dir, ["rev-parse", "--short", "HEAD"], { timeout: READ_TIMEOUT_MS, readOnly: true }) : Promise.resolve(undefined),
    readInProgress(dir),
  ])
  if (!refs.ok) return { ok: false, error: describeSwitchFailure(refs.stderr) }
  const lines = refs.stdout.split(/\r?\n/).filter(Boolean).length
  return {
    ok: true,
    toplevel,
    current: detached ? `HEAD(${sha?.ok ? sha.stdout.trim() : "?"})` : abbrev,
    detached,
    branches: parseBranchRefs(refs.stdout, { ...(detached ? {} : { current: abbrev }), ownTop: toplevel }),
    // status 失败（超时等）不影响切换，只是不知道改了几个
    dirty: status.ok ? parseDirtyCount(status.stdout) : 0,
    truncated: lines >= MAX_REFS,
    ...(inProgress ? { inProgress } : {}),
  }
}

export type SwitchOutcome = { ok: true; current: string } | { ok: false; error: string }

/**
 * 切换分支。不用 -f，不 stash：有改动被覆盖时 git 自己拒绝，原因翻成人话交回去。
 * 目标先和刚读的分支列表核对，不在列表里的一律不交给 git（参数不是从界面直接拼进命令的）。
 */
export async function switchBranch(dir: string, target: BranchTarget): Promise<SwitchOutcome> {
  const state = await readBranchState(dir)
  if (!state.ok) return state
  if (state.inProgress) return { ok: false, error: state.inProgress }
  const option = state.branches.find((b) => b.kind === target.kind && b.name === target.name && (b.kind === "local" || b.remote === target.remote))
  if (!option) return { ok: false, error: "分支不存在（可能刚被删除），请重新打开分支列表" }
  if (option.current) return { ok: true, current: state.current }
  if (option.checkedOutAt) return { ok: false, error: `这个分支已在另一个工作目录检出：${option.checkedOutAt}` }

  const args = option.kind === "local"
    // 末尾的 -- 让 git 一定把它当分支名，不会误认成同名文件
    ? ["checkout", option.name, "--"]
    : ["checkout", "-b", option.name, "--track", `${option.remote}/${option.name}`]
  const r = await runGit(dir, args, { timeout: SWITCH_TIMEOUT_MS })
  if (!r.ok) return { ok: false, error: describeSwitchFailure(r.stderr) }

  const after = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: READ_TIMEOUT_MS, readOnly: true })
  return { ok: true, current: after.ok ? after.stdout.trim() || option.name : option.name }
}
