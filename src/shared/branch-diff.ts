import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export const LIMITS = { maxFiles: 120, maxFileBytes: 512 * 1024, maxTotalBytes: 8 * 1024 * 1024 }

/** 模板行：["c", oldLn, newLn, text] | ["d", oldLn, text] | ["a", newLn, text] */
export type DiffRow = ["c", number, number, string] | ["d", number, string] | ["a", number, string]
export interface DiffHunk { h: string; r: DiffRow[] }
export interface DiffFileEntry {
  path: string
  add: number
  del: number
  base: string[]
  head: string[]
  delLines: number[]
  addLines: number[]
  hunks: DiffHunk[]
  fullHunks: DiffHunk[]
}
export interface DiffData {
  title?: string
  baseLabel: string
  headLabel: string
  baseRef: string
  stat: string
  commits: string[]
  files: DiffFileEntry[]
  file_count: number
  commit_count: number
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 })
  } catch (e: any) {
    throw new Error(`git 失败 (${args.join(" ")}): ${e?.message ?? e}`)
  }
}

function revExists(cwd: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, encoding: "utf-8" })
    return true
  } catch {
    return false
  }
}

export function resolveRepoRoot(repoPath: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repoPath, encoding: "utf-8" }).trim()
    if (!root) throw new Error("x")
    return root
  } catch {
    throw new Error(`非 git 目录：${repoPath}（及其上级）不在 git 仓库内`)
  }
}

/** 会话工作目录：与 daemon.ts extractWorkspaceDir 同规则（sessionKey 后缀为路径形态才是工作目录） */
export function scopeDirFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined
  const idx = sessionKey.indexOf("::")
  if (idx < 0) return undefined
  const wsDir = sessionKey.slice(idx + 2)
  if (!wsDir || !/[\\/]/.test(wsDir)) return undefined
  return wsDir
}

/** 目录身份：dev+ino，同一目录的短名/大小写/分隔符/软链写法收敛到同一身份 */
function dirId(p: string): string | undefined {
  try {
    const s = fs.statSync(p)
    return `${s.dev}:${s.ino}`
  } catch {
    return undefined
  }
}

/** 越界即抛：有会话工作目录时，仓库根必须与其同目录或在其内部 */
export function resolveScopedRepoRoot(repoPath: string, sessionKey?: string): string {
  const root = resolveRepoRoot(repoPath)
  const scope = scopeDirFromSessionKey(sessionKey)
  if (!scope) return root
  // 身份比对：win 8.3 短名（RUNNER~1）这类写法差异直接免疫
  const scopeId = dirId(scope)
  if (scopeId) {
    let cur = root
    for (;;) {
      if (dirId(cur) === scopeId) return root
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    throw new Error(`越界：repo_path 解析到 ${root}，不在当前会话工作目录 ${scope} 内`)
  }
  // scope 不存在时的兜底：字符串比对（大小写/分隔符不敏感）
  const norm = (p: string) => p.replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase()
  const r = norm(root)
  const s = norm(scope)
  if (r !== s && !r.startsWith(s + "\\") && !r.startsWith(s + "/")) {
    throw new Error(`越界：repo_path 解析到 ${root}，不在当前会话工作目录 ${scope} 内`)
  }
  return root
}

function splitLines(text: string): string[] {
  const parts = text.split("\n")
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop()
  return parts
}

/** 解析 unified diff（-U0 或大上下文）为 hunks；非文本（Binary）返回空 */
export function parseUnifiedDiff(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let cur: DiffHunk | null = null
  let oldLn = 0
  let newLn = 0
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
      cur = { h: raw, r: [] }
      hunks.push(cur)
      oldLn = m ? Number(m[1]) : 0
      newLn = m ? Number(m[3]) : 0
      continue
    }
    if (!cur) continue
    if (raw.startsWith("\\ ")) continue // \ No newline at end of file
    const kind = raw[0]
    const text = raw.slice(1)
    if (kind === " ") {
      cur.r.push(["c", oldLn, newLn, text])
      oldLn += 1
      newLn += 1
    } else if (kind === "-") {
      if (raw.startsWith("---")) continue // 文件头（hunk 外已由 cur==null 挡掉，此处兜底）
      cur.r.push(["d", oldLn, text])
      oldLn += 1
    } else if (kind === "+") {
      if (raw.startsWith("+++")) continue
      cur.r.push(["a", newLn, text])
      newLn += 1
    }
  }
  return hunks
}

function showFile(root: string, ref: string, filePath: string): string[] {
  try {
    const out = execFileSync("git", ["show", `${ref}:${filePath}`], { cwd: root, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 })
    return splitLines(out)
  } catch {
    return [] // 新文件（base 为空）或已删除（head 为空）
  }
}

export function buildDiffData(opts: {
  repoPath: string
  baseRef: string
  headRef?: string
  paths?: string[]
  title?: string
  headLabel?: string
  sessionKey?: string
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}): DiffData {
  const maxFiles = opts.maxFiles ?? LIMITS.maxFiles
  const maxFileBytes = opts.maxFileBytes ?? LIMITS.maxFileBytes
  const maxTotalBytes = opts.maxTotalBytes ?? LIMITS.maxTotalBytes
  const root = resolveScopedRepoRoot(opts.repoPath, opts.sessionKey)
  const head = opts.headRef?.trim() ? opts.headRef.trim() : "HEAD"
  if (!revExists(root, opts.baseRef)) throw new Error(`ref 不存在：${opts.baseRef}`)
  if (!revExists(root, head)) throw new Error(`ref 不存在：${head}`)
  const range = `${opts.baseRef}..${head}`
  const pathArgs = opts.paths?.length ? ["--", ...opts.paths] : []

  const stat = runGit(root, ["diff", "--stat", range, ...pathArgs])
  const rawNames = runGit(root, ["diff", "--name-only", "-z", range, ...pathArgs])
  const names = rawNames.split("\0").map((s) => s.trim()).filter(Boolean)
  if (names.length === 0) throw new Error("无变更：base..head 为空")
  if (names.length > maxFiles) throw new Error(`超限：文件数 ${names.length} 超过上限 ${maxFiles}`)

  const numstat = new Map<string, { add: number; del: number }>()
  for (const entry of runGit(root, ["diff", "--numstat", "-z", range, ...pathArgs]).split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entry.trim())
    if (!m) continue
    numstat.set(m[3], { add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]) })
  }

  const files: DiffFileEntry[] = []
  let totalBytes = 0
  for (const name of names) {
    const ns = numstat.get(name) ?? { add: 0, del: 0 }
    const base = showFile(root, opts.baseRef, name)
    const headLines = showFile(root, head, name)
    const bytes = base.join("\n").length + headLines.join("\n").length
    if (bytes > maxFileBytes) throw new Error(`超限：${name} 约 ${bytes} 字节，超过单文件上限 ${maxFileBytes}`)
    totalBytes += bytes
    if (totalBytes > maxTotalBytes) throw new Error(`超限：总量约 ${totalBytes} 字节，超过上限 ${maxTotalBytes}`)

    const hunks = parseUnifiedDiff(runGit(root, ["diff", "-U0", "--no-color", "--no-ext-diff", range, "--", name]))
    const fullHunks = parseUnifiedDiff(runGit(root, ["diff", "-U999999", "--no-color", "--no-ext-diff", range, "--", name]))
    const delLines: number[] = []
    const addLines: number[] = []
    for (const h of hunks) {
      for (const row of h.r) {
        if (row[0] === "d") delLines.push(row[1])
        else if (row[0] === "a") addLines.push(row[1])
      }
    }
    files.push({ path: name, add: ns.add, del: ns.del, base, head: headLines, delLines, addLines, hunks, fullHunks })
  }

  const commits = splitLines(runGit(root, ["log", "--format=%h %s", range]))
  return {
    title: opts.title,
    baseLabel: opts.baseRef,
    headLabel: opts.headLabel?.trim() ? opts.headLabel.trim() : head,
    baseRef: opts.baseRef,
    stat,
    commits,
    files,
    file_count: files.length,
    commit_count: commits.length,
  }
}

export function injectDiffData(templateHtml: string, data: DiffData): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c")
  const re = /(<script[^>]*id="diff-data"[^>]*>)([\s\S]*?)(<\/script>)/
  if (!re.test(templateHtml)) throw new Error("模板缺少 #diff-data 占位")
  return templateHtml.replace(re, `$1${json}$3`)
}
