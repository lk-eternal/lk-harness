import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  addProjectClone, ensureCheckouts, syncCheckout, isGitRepoRoot, isRemoteRepoRef, removeProjectWorktree,
  isValidBranchName, inspectLocalRepo, removeDirRobust,
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
    // Windows 上超时残留的 git 子进程会占住句柄，直接 rm 会 EPERM：带重试兜底
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 } as fs.RmOptions)
    } catch {
      try {
        // 兜底：给残留进程一点退出时间再删一次，还删不掉就留给 runner 清理，不让清理失败掩盖真实断言
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 } as fs.RmOptions)
      } catch { /* ignore: CI 临时目录由 runner 回收 */ }
    }
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

  it("远程要登录凭据：直接失败说明原因，不会卡着等输入，也不留半成品目录", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' })
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const { port } = server.address() as { port: number }
    // 不让本机的凭据管理器（Windows 的 GCM 会弹窗）和询问程序插手：只测「没人能回答时不挂住」
    const keys = ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_ASKPASS", "SSH_ASKPASS"] as const
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    const emptyConfig = path.join(root, "empty-gitconfig")
    fs.writeFileSync(emptyConfig, "")
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    process.env.GIT_CONFIG_GLOBAL = emptyConfig
    delete process.env.GIT_ASKPASS
    delete process.env.SSH_ASKPASS
    try {
      const wt = path.join(wtRoot, "remote")
      const started = Date.now()
      const r = await addProjectClone({
        repoPath: `http://127.0.0.1:${port}/x.git`, worktreePath: wt, featureBranch: "feature/a", baseBranch: "main",
      })
      expect(r.ok).toBe(false)
      expect(r.error).toContain("git clone 失败")
      // 说清楚是缺登录凭据（不是「No such file or directory」这类看不懂的），并告诉用户怎么办
      expect(r.error).toContain("terminal prompts disabled")
      expect(r.error).toContain("需要登录凭据")
      expect(Date.now() - started).toBeLessThan(20_000)
      expect(fs.existsSync(wt)).toBe(false)
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 30_000)

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
    expect(note.note).toMatch(/已同步远程 1 个新提交/)
    expect(git(wt, ["rev-parse", "HEAD"])).not.toBe(before)
    expect(fs.readFileSync(path.join(wt, "a.txt"), "utf-8").replace(/\r\n/g, "\n")).toBe("2\n")
  })

  it("isValidBranchName: 合法名通过，空、以 - 开头、含空格/.. 的不通过", async () => {
    expect(await isValidBranchName("feature/0511-改版")).toBe(true)
    expect(await isValidBranchName("  main  ")).toBe(true)
    for (const bad of ["", "   ", "-x", "a b", "a..b", "a~1", "feature/", "x.lock"]) {
      expect(await isValidBranchName(bad), `「${bad}」`).toBe(false)
    }
  })

  it("inspectLocalRepo: 给出默认基线分支和分支列表（本地 + origin，去重排序）", async () => {
    git(repo, ["branch", "develop"])
    const r = await inspectLocalRepo(repo)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.info.defaultBranch).toBe("main")
    expect(r.info.branches).toEqual(["develop", "main"])

    // 克隆出来的仓库：origin/HEAD 指向 main，origin 上的分支也在列表里
    const cloned = path.join(wtRoot, "cloned")
    git(wtRoot, ["clone", repo, cloned])
    const r2 = await inspectLocalRepo(cloned)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.info.defaultBranch).toBe("main")
    expect(r2.info.branches).toEqual(["develop", "main"])
  })

  it("inspectLocalRepo: 相对路径、不存在、不是仓库根目录都给人话报错", async () => {
    const rel = await inspectLocalRepo("some/where")
    expect(rel.ok).toBe(false)
    const missing = await inspectLocalRepo(path.join(root, "nope"))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toContain("不存在")
    const notRepo = await inspectLocalRepo(wtRoot)
    expect(notRepo.ok).toBe(false)
    if (!notRepo.ok) expect(notRepo.error).toContain("git")
  })

  it("removeDirRobust: 含中文路径的目录（连只读文件）也能删干净，不存在的目录不报错", async () => {
    const dir = path.join(root, "改版", "shop")
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true })
    fs.writeFileSync(path.join(dir, "sub", "ro.txt"), "x")
    fs.chmodSync(path.join(dir, "sub", "ro.txt"), 0o444)
    await removeDirRobust(dir)
    expect(fs.existsSync(dir)).toBe(false)
    await expect(removeDirRobust(path.join(root, "没有这个目录"))).resolves.toBeUndefined()
  })
})

