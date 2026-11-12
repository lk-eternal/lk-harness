import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readGitHead } from "../src/shared/git-head"
import { readGitBranch, readGitBranchViaGit } from "../src/shared/session-label"

/**
 * 读分支不再起 git 进程（直接读 .git/HEAD），但结果必须和 `git rev-parse --abbrev-ref HEAD` 一致。
 * 这里用真实的 git 建各种形态的仓库，逐个和旧实现（readGitBranchViaGit）对拍。
 */
let root = ""

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function newRepo(name: string, branch = "main"): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", branch)
  git(dir, "commit", "-q", "--allow-empty", "-m", "init")
  return dir
}

/** 新实现和旧实现必须给出同一个答案；返回这个答案 */
function same(dir: string): string | undefined {
  const viaGit = readGitBranchViaGit(dir)
  expect(readGitBranch(dir)).toBe(viaGit)
  return viaGit
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-git-head-"))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("readGitHead / readGitBranch 与 git 命令一致", () => {
  it("普通分支：直接读出，不需要回落", () => {
    const dir = newRepo("plain")
    expect(readGitHead(dir)).toEqual({ kind: "branch", name: "main" })
    expect(same(dir)).toBe("main")
  })

  it("仓库的子目录", () => {
    const dir = newRepo("sub")
    const deep = path.join(dir, "a", "b")
    fs.mkdirSync(deep, { recursive: true })
    expect(readGitHead(deep)).toEqual({ kind: "branch", name: "main" })
    expect(same(deep)).toBe("main")
  })

  it("带斜杠的分支名", () => {
    const dir = newRepo("slash")
    git(dir, "checkout", "-q", "-b", "feature/list-speed")
    expect(readGitHead(dir)).toEqual({ kind: "branch", name: "feature/list-speed" })
    expect(same(dir)).toBe("feature/list-speed")
  })

  it("引用被打包进 packed-refs 之后仍然认得出", () => {
    const dir = newRepo("packed")
    git(dir, "checkout", "-q", "-b", "release/1.4")
    git(dir, "pack-refs", "--all")
    // 松散文件确实没了，只剩 packed-refs
    expect(fs.existsSync(path.join(dir, ".git", "refs", "heads", "release", "1.4"))).toBe(false)
    expect(readGitHead(dir)).toEqual({ kind: "branch", name: "release/1.4" })
    expect(same(dir)).toBe("release/1.4")
  })

  it("游离 HEAD：不自己猜，回落到 git，仍然是 HEAD(短哈希)", () => {
    const dir = newRepo("detached")
    git(dir, "checkout", "-q", "--detach")
    expect(readGitHead(dir).kind).toBe("unknown")
    const out = same(dir)
    expect(out).toMatch(/^HEAD\([0-9a-f]{7,}\)$/)
  })

  it("还没有提交的新仓库：分支不存在，和 git 一样没有分支", () => {
    const dir = path.join(root, "unborn")
    fs.mkdirSync(dir, { recursive: true })
    git(dir, "init", "-q", "-b", "main")
    expect(readGitHead(dir).kind).toBe("unknown")
    expect(same(dir)).toBeUndefined()
  })

  it("worktree：分支是这个 worktree 自己的", () => {
    const dir = newRepo("wt-main")
    const wt = path.join(root, "wt-linked")
    git(dir, "worktree", "add", "-q", wt, "-b", "wt-branch")
    expect(readGitHead(wt)).toEqual({ kind: "branch", name: "wt-branch" })
    expect(same(wt)).toBe("wt-branch")
    // 主工作区不受影响
    expect(same(dir)).toBe("main")
  })

  it(".git 是指向别处的文件（子模块 / 分离的 git 目录）", () => {
    const dir = newRepo("gitdir-target")
    const other = path.join(root, "gitdir-pointer")
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, ".git"), `gitdir: ${path.join(dir, ".git")}\n`)
    expect(readGitHead(other)).toEqual({ kind: "branch", name: "main" })
    expect(same(other)).toBe("main")
  })

  it("不在任何仓库里：确定没有分支，不用起 git", () => {
    const dir = path.join(root, "not-a-repo")
    fs.mkdirSync(dir, { recursive: true })
    expect(readGitHead(dir)).toEqual({ kind: "none" })
    expect(same(dir)).toBeUndefined()
  })

  it("目录不存在：没有分支（不能因为祖先目录是仓库就误报）", () => {
    const dir = newRepo("ancestor")
    const missing = path.join(dir, "no", "such", "dir")
    expect(readGitHead(missing)).toEqual({ kind: "none" })
    expect(same(missing)).toBeUndefined()
  })

  it("路径是文件不是目录：没有分支", () => {
    const dir = newRepo("file-path")
    const file = path.join(dir, "a.txt")
    fs.writeFileSync(file, "x")
    expect(readGitHead(file)).toEqual({ kind: "none" })
    expect(same(file)).toBeUndefined()
  })

  it("设了 GIT_DIR：找仓库的规则变了，不自己猜", () => {
    const dir = newRepo("env-git-dir")
    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = path.join(dir, ".git")
    try {
      expect(readGitHead(dir).kind).toBe("unknown")
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
  })
})
