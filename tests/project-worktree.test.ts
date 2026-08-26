import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  addProjectClone, ensureCheckouts, syncCheckout, isGitRepoRoot, isRemoteRepoRef, removeProjectWorktree,
} from "../electron/project-worktree.js"

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || "git failed")
  return (r.stdout || "").trim()
}

describe("project-worktree (independent checkout)", () => {
  let root: string
  let repo: string
  let wtRoot: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claw-wt-"))
    repo = path.join(root, "repo")
    wtRoot = path.join(root, "trees")
    fs.mkdirSync(repo)
    fs.mkdirSync(wtRoot)
    git(repo, ["init"])
    git(repo, ["config", "user.email", "t@t.com"])
    git(repo, ["config", "user.name", "t"])
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n")
    git(repo, ["add", "."])
    git(repo, ["commit", "-m", "init"])
    git(repo, ["branch", "-M", "main"])
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("detects git root and remote refs", async () => {
    expect(await isGitRepoRoot(repo)).toBe(true)
    expect(await isGitRepoRoot(wtRoot)).toBe(false)
    expect(isRemoteRepoRef("https://github.com/foo/bar.git")).toBe(true)
    expect(isRemoteRepoRef("git@github.com:foo/bar.git")).toBe(true)
    expect(isRemoteRepoRef(repo)).toBe(false)
  })

  it("clones independently and creates feature from base", async () => {
    const wt = path.join(wtRoot, "feat-a")
    const r = await addProjectClone({
      repoPath: repo,
      worktreePath: wt,
      featureBranch: "feature/a",
      baseBranch: "main",
    })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true)
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/a")
    // 独立 .git，非 worktree 挂接
    expect(fs.statSync(path.join(wt, ".git")).isDirectory()).toBe(true)

    const r2 = await addProjectClone({
      repoPath: repo,
      worktreePath: wt,
      featureBranch: "feature/b",
      baseBranch: "main",
    })
    expect(r2.ok).toBe(false)
    await removeProjectWorktree(repo, wt)
    expect(fs.existsSync(wt)).toBe(false)
  })

  it("succeeds even when the branch is checked out in the source repo", async () => {
    git(repo, ["checkout", "-b", "feature/busy"])
    const wt = path.join(wtRoot, "busy")
    const r = await addProjectClone({
      repoPath: repo,
      worktreePath: wt,
      featureBranch: "feature/busy",
      baseBranch: "main",
    })
    expect(r.ok).toBe(true)
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/busy")
    // 双方可同时检出同一分支
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/busy")
  })

  it("ensureCheckouts rebuilds a missing directory", async () => {
    const wt = path.join(wtRoot, "rebuild")
    const refs = [{ repoPath: repo, worktreePath: wt, baseBranch: "main" }]
    expect((await ensureCheckouts(refs, "feature/r")).ok).toBe(true)
    fs.rmSync(wt, { recursive: true, force: true })
    const again = await ensureCheckouts(refs, "feature/r")
    expect(again.ok).toBe(true)
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/r")
  })

  it("ensureCheckouts creates missing feature branch when clone dir already exists", async () => {
    const wt = path.join(wtRoot, "existing")
    expect((await addProjectClone({
      repoPath: repo,
      worktreePath: wt,
      featureBranch: "feature/old",
      baseBranch: "main",
    })).ok).toBe(true)
    git(wt, ["checkout", "main"])
    git(wt, ["branch", "-D", "feature/old"])
    const refs = [{ repoPath: repo, worktreePath: wt, baseBranch: "main" }]
    const r = await ensureCheckouts(refs, "feature/new")
    expect(r.ok).toBe(true)
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/new")
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true)
  })

  it("syncCheckout fast-forwards when remote feature advances", async () => {
    git(repo, ["checkout", "-b", "feature/sync"])
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n")
    git(repo, ["add", "."])
    git(repo, ["commit", "-m", "sync1"])
    const wt = path.join(wtRoot, "sync")
    expect((await addProjectClone({
      repoPath: repo,
      worktreePath: wt,
      featureBranch: "feature/sync",
      baseBranch: "main",
    })).ok).toBe(true)
    fs.writeFileSync(path.join(repo, "a.txt"), "2\n")
    git(repo, ["add", "."])
    git(repo, ["commit", "-m", "sync2"])
    const before = git(wt, ["rev-parse", "HEAD"])
    const note = await syncCheckout(wt, "feature/sync")
    expect(note.note).toMatch(/已同步远�?)
    expect(git(wt, ["rev-parse", "HEAD"])).not.toBe(before)
    expect(fs.readFileSync(path.join(wt, "a.txt"), "utf-8").replace(/\r\n/g, "\n")).toBe("2\n")
  })
})

