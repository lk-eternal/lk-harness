// ── 会话工作目录的 git 分支：切换的共用规则 ─────────────────────────────
// 桌面端（对话页）、手机端、主进程用同一份：分支列表怎么解析、分组搜索、能不能切、git 报错怎么说成人话。
// 这里只有纯函数和类型，不碰 git 进程（执行在 electron/git-branch.ts）。

import { sameChatDir } from "./app-chat-types.js"

export type BranchKind = "local" | "remote"

export interface BranchOption {
  /** 本地分支：分支名；远程分支：选中后要建的本地分支名（不带远程前缀） */
  name: string
  kind: BranchKind
  /** 仅远程分支：它所在的远程（origin 等） */
  remote?: string
  /** 工作目录现在就在这个分支上 */
  current?: boolean
  /** 已在别的工作目录检出：git 不允许同一个分支同时检出两处，所以切不过去 */
  checkedOutAt?: string
  /** 最近一次提交的时间（秒） */
  committedAt?: number
}

/** 要切到哪个分支：电脑端会重新核对它确实在分支列表里，才会交给 git */
export interface BranchTarget {
  name: string
  kind: BranchKind
  remote?: string
}

/** 把界面/网关传来的目标收成规范形态：只认 name、kind、remote，类型不对的当成没有 */
export function parseBranchTarget(raw: unknown): BranchTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.name !== "string" || o.name === "") return undefined
  if (o.kind === "remote") {
    return typeof o.remote === "string" && o.remote !== "" ? { name: o.name, kind: "remote", remote: o.remote } : undefined
  }
  return { name: o.name, kind: "local" }
}

export interface BranchListData {
  /** 当前分支名；游离 HEAD 时是 `HEAD(abc1234)` */
  current: string
  detached: boolean
  branches: BranchOption[]
  /** 已跟踪文件里有改动的个数（未跟踪的新文件不影响切分支，不计） */
  dirty: number
  /** 分支太多只列了最近的一部分 */
  truncated?: boolean
  /** 现在不能切的原因（有会话在这个目录里工作、正在 rebase 等）；有值时所有分支都不可选 */
  blocked?: string
}

export type BranchListResult = ({ ok: true } & BranchListData) | { ok: false; error: string }
export type BranchSwitchResult = { ok: true; current: string } | { ok: false; error: string }

/** 旧版电脑端没有切分支的接口，网关回「未知接口」 */
export const OLD_DESKTOP_BRANCH = "电脑端版本过旧，不支持切换分支，请把电脑端升级到最新版本"

/** 分支标签是不是游离 HEAD（`HEAD(abc1234)` 或 `HEAD`） */
export function isDetachedLabel(label: string): boolean {
  return /^HEAD(\(.*\))?$/.test(label)
}

/**
 * 会话能不能切分支：项目会话的分支由项目流程管（独立克隆、基线、feature 分支），不在这里切；
 * 其它（主目录、常用目录、选了目录的临时会话）的目录在用户手里，可以切。
 */
export function canSwitchBranch(kind: string): boolean {
  return kind === "main" || kind === "dir" || kind === "temp"
}

/** 解析 `git for-each-ref --format=%(refname)%09%(committerdate:unix)%09%(worktreepath)` 的输出 */
export function parseBranchRefs(
  stdout: string,
  opts: { current?: string; ownTop?: string } = {},
): BranchOption[] {
  const locals: BranchOption[] = []
  const remotes: BranchOption[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    const [ref, ts, wt] = line.split("\t")
    const committedAt = Number(ts) > 0 ? Number(ts) : undefined
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length)
      const elsewhere = wt && !sameChatDir(wt, opts.ownTop) ? wt : undefined
      locals.push({
        name,
        kind: "local",
        ...(committedAt ? { committedAt } : {}),
        ...(opts.current !== undefined && name === opts.current ? { current: true } : {}),
        ...(elsewhere ? { checkedOutAt: elsewhere } : {}),
      })
    } else if (ref.startsWith("refs/remotes/")) {
      const rest = ref.slice("refs/remotes/".length)
      const slash = rest.indexOf("/")
      if (slash <= 0) continue
      const name = rest.slice(slash + 1)
      if (!name || name === "HEAD") continue
      remotes.push({ name, kind: "remote", remote: rest.slice(0, slash), ...(committedAt ? { committedAt } : {}) })
    }
  }
  // 当前分支放最前面，其余保持「最近提交在前」
  const ordered = [...locals.filter((b) => b.current), ...locals.filter((b) => !b.current)]
  // 远程分支只列本地还没有的；同名分支在几个远程都有时只列一次（git 会按选中的远程建跟踪）
  const taken = new Set(locals.map((b) => b.name))
  const remoteOnly = remotes.filter((b) => {
    if (taken.has(b.name)) return false
    taken.add(b.name)
    return true
  })
  return [...ordered, ...remoteOnly]
}

/** `git status --porcelain -uno` 的行数 */
export function parseDirtyCount(porcelain: string): number {
  return porcelain.split(/\r?\n/).filter((l) => l.trim() !== "").length
}

const IN_PROGRESS_LABEL: Record<string, string> = {
  "rebase-merge": "rebase",
  "rebase-apply": "rebase",
  MERGE_HEAD: "合并",
  CHERRY_PICK_HEAD: "cherry-pick",
  REVERT_HEAD: "revert",
  BISECT_LOG: "bisect",
}

/** 这些文件存在说明 git 正在做一件做到一半的事；中途换分支会把它搅乱 */
export const IN_PROGRESS_MARKERS: readonly string[] = Object.keys(IN_PROGRESS_LABEL)

export function inProgressReason(marker: string): string {
  const what = IN_PROGRESS_LABEL[marker] ?? marker
  return `目录里有一次 ${what} 做到一半，请先完成或中止它再切换分支`
}

/** 分支名里的目录名（「已在 xxx 检出」用） */
function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/** git 切换失败的输出翻成一句人话；认不出的原样给出（去掉 error:/fatal: 前缀，最多两行） */
export function describeSwitchFailure(stderr: string): string {
  const text = stderr.replace(/\r/g, "").trim()
  const files = (header: RegExp): string[] => {
    const m = header.exec(text)
    if (!m) return []
    const out: string[] = []
    for (const line of text.slice(m.index + m[0].length).split("\n")) {
      if (!line.startsWith("\t") && !line.startsWith("    ")) break
      out.push(line.trim())
    }
    return out
  }
  const listFiles = (names: string[]): string => {
    if (names.length === 0) return ""
    const shown = names.slice(0, 3).join("、")
    return `（${shown}${names.length > 3 ? ` 等 ${names.length} 个文件` : ""}）`
  }

  if (/local changes to the following files would be overwritten/i.test(text)) {
    const names = files(/local changes to the following files would be overwritten by (?:checkout|merge)[^\n]*\n/i)
    return `有未提交的改动会被目标分支覆盖${listFiles(names)}，请先提交或暂存`
  }
  if (/untracked working tree files would be overwritten/i.test(text)) {
    const names = files(/untracked working tree files would be overwritten by (?:checkout|merge)[^\n]*\n/i)
    return `有未跟踪的文件会被目标分支覆盖${listFiles(names)}，请先移走或提交`
  }
  const used = /(?:is already (?:checked out|used by worktree) at) '([^']+)'/i.exec(text)
  if (used) return `这个分支已在另一个工作目录检出：${used[1]}`
  if (/index\.lock/i.test(text)) return "另一个 git 操作正在进行（index.lock 被占用），等它结束再试"
  if (/need(?:s)? merge|resolve your current index first|unmerged/i.test(text)) return "目录里有没解决的合并冲突，请先处理"
  if (/not a git repository/i.test(text)) return "这个目录不是 git 仓库"
  if (/did not match any|invalid reference|unknown revision|not a valid/i.test(text)) return "分支不存在（可能刚被删除），请重新打开分支列表"
  if (/ENOENT|not recognized|command not found/i.test(text)) return "没有找到 git，请确认电脑端装了 git"
  if (/timed out|ETIMEDOUT|SIGTERM/i.test(text)) return "git 响应超时，请稍后再试"

  const lines = text.split("\n").map((l) => l.replace(/^(error|fatal|warning):\s*/i, "").trim()).filter(Boolean)
  const joined = lines.slice(0, 2).join("；")
  return (joined || "切换失败").slice(0, 300)
}

export function branchKey(b: BranchOption): string {
  return `${b.kind}:${b.remote ?? ""}:${b.name}`
}

export interface BranchRow {
  key: string
  option: BranchOption
  /** 点不了：现在整体不能切，或这个分支在别处检出 */
  disabled: boolean
  /** 行内小字，说明为什么点不了 */
  note?: string
}

export interface BranchGroupView {
  kind: BranchKind
  label: string
  rows: BranchRow[]
  /** 没显示出来的个数（太多了只显示前面一部分，搜索可以缩小范围） */
  hidden: number
}

export const BRANCH_ROW_LIMIT = 80

/** 搜索框：不分大小写；远程分支也能按「origin/xxx」搜 */
export function matchesBranchQuery(b: BranchOption, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (b.name.toLowerCase().includes(q)) return true
  return b.kind === "remote" && `${b.remote}/${b.name}`.toLowerCase().includes(q)
}

/** 分支菜单要显示的分组：本地分支在前，只在远程有的在后；每组最多显示 limit 个 */
export function branchGroups(
  data: Pick<BranchListData, "branches" | "blocked">,
  query: string,
  limit: number = BRANCH_ROW_LIMIT,
): BranchGroupView[] {
  const matched = data.branches.filter((b) => matchesBranchQuery(b, query))
  const toRow = (b: BranchOption): BranchRow => {
    const elsewhere = !!b.checkedOutAt
    return {
      key: branchKey(b),
      option: b,
      disabled: !b.current && (!!data.blocked || elsewhere),
      ...(elsewhere ? { note: `已在「${baseName(b.checkedOutAt as string)}」检出` } : {}),
    }
  }
  const groups: BranchGroupView[] = []
  const locals = matched.filter((b) => b.kind === "local")
  if (locals.length > 0) {
    groups.push({ kind: "local", label: "本地分支", rows: locals.slice(0, limit).map(toRow), hidden: Math.max(0, locals.length - limit) })
  }
  const remotes = matched.filter((b) => b.kind === "remote")
  if (remotes.length > 0) {
    const names = [...new Set(remotes.map((b) => b.remote))]
    const where = names.length === 1 ? `远程 ${names[0]}` : "远程"
    groups.push({
      kind: "remote",
      label: `${where} · 选中后创建同名本地分支`,
      rows: remotes.slice(0, limit).map(toRow),
      hidden: Math.max(0, remotes.length - limit),
    })
  }
  return groups
}

export interface BranchNotice {
  tone: "warn" | "info"
  text: string
}

/** 菜单顶部的提示：为什么切不了 / 切换会影响什么（桌面端和手机端同一套话） */
export function branchNotices(opts: { blocked?: string; dirty: number; shared: number; truncated?: boolean }): BranchNotice[] {
  const out: BranchNotice[] = []
  if (opts.blocked) out.push({ tone: "warn", text: opts.blocked })
  if (opts.shared > 1) out.push({ tone: "info", text: `这个目录有 ${opts.shared} 个会话在用，切换对它们都生效` })
  if (opts.dirty > 0 && !opts.blocked) {
    out.push({ tone: "info", text: `有 ${opts.dirty} 个文件有改动，切换时会带到新分支；有冲突时 git 会拒绝，不会丢改动` })
  }
  if (opts.truncated) out.push({ tone: "info", text: "分支很多，只列了最近有提交的一部分，可以用搜索缩小范围" })
  return out
}

/** 目录相同的会话个数（含当前这个）：菜单里提醒「切换对它们都生效」 */
export function sharedSessionCount<T>(tabs: readonly T[], dirOfTab: (t: T) => string | undefined, dir: string | undefined): number {
  if (!dir) return 0
  return tabs.filter((t) => sameChatDir(dirOfTab(t), dir)).length
}

/** 刚切完、列表还没刷新到的这一小段时间里，按钮上先显示新分支 */
export interface BranchOverride {
  from: string
  to: string
  until: number
}

export const BRANCH_OVERRIDE_MS = 12_000

export function makeBranchOverride(from: string, to: string, now: number): BranchOverride {
  return { from, to, until: now + BRANCH_OVERRIDE_MS }
}

/**
 * 按钮上显示的分支：列表里读到的还是切换前的旧值（刷新在切换之前发出、晚到了）就先显示新分支；
 * 读到别的值（已经刷新到，或你在终端里又切了）、或超过期限，一律以读到的为准。
 */
export function shownBranch(actual: string | undefined, override: BranchOverride | null, now: number): string | undefined {
  if (override && actual === override.from && now < override.until) return override.to
  return actual
}
