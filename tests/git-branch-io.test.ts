import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { readBranchState, switchBranch, type BranchState } from "../electron/git-branch"
import { sameChatDir } from "../src/shared/app-chat-types"

/**
 * 真实 git 仓库上的切分支：临时目录里建一个带远程（本地裸仓库当 origin）的仓库，
 * 路径里带空格和中文，分支名也带中文，验证列表、切换、带着改动切换、冲突拒绝、别处检出拒绝等。
 * 仓库只建一次当模板，每个用例复制一份（Windows 上起 git 进程慢，每个用例都重建要多花几十秒）。
 */

const REPO_NAME = "my repo 中文"

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `git ${args.join(" ")} failed`)
  return (r.stdout || "").trim()
}

function commitFile(repo: string, file: string, content: string, message: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), content)
  git(repo, ["add", "."])
  git(repo, ["commit", "-m", message])
}

function rmRobust(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 } as fs.RmOptions)
  } catch { /* Windows 上残留的 git 子进程占着句柄：留给系统临时目录回收 */ }
}

describe("会话切分支：真实 git 仓库", () => {
  let template: string
  let root: string
  let repo: string

  const state = async (dir = repo): Promise<BranchState> => {
    const s = await readBranchState(dir)
    if (!s.ok) throw new Error(s.error)
    return s
  }
  const head = () => git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])

  beforeAll(() => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), "branch-io-tpl-"))
    const origin = path.join(template, "origin.git")
    fs.mkdirSync(origin)
    git(origin, ["init", "--bare"])

    const tpl = path.join(template, REPO_NAME)
    fs.mkdirSync(tpl)
    git(tpl, ["init"])
    git(tpl, ["config", "user.email", "t@t.com"])
    git(tpl, ["config", "user.name", "t"])
    commitFile(tpl, "README.md", "main\n", "init")
    git(tpl, ["branch", "-M", "main"])
    git(tpl, ["remote", "add", "origin", origin])
    git(tpl, ["push", "-u", "origin", "main"])

    // feature/a：README 内容和 main 不同（用来造冲突）；feature/中文 用来测非 ASCII 分支名
    git(tpl, ["checkout", "-b", "feature/a"])
    commitFile(tpl, "README.md", "feature a\n", "a")
    git(tpl, ["checkout", "main"])
    git(tpl, ["branch", "feature/中文"])
    // release/1.0 只在远程有：推上去再删掉本地的
    git(tpl, ["checkout", "-b", "release/1.0"])
    commitFile(tpl, "release.txt", "r\n", "release")
    git(tpl, ["push", "origin", "release/1.0"])
    git(tpl, ["checkout", "main"])
    git(tpl, ["branch", "-D", "release/1.0"])
    git(tpl, ["fetch", "origin"])
  }, 60_000)

  afterAll(() => rmRobust(template))

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-io-"))
    fs.cpSync(template, root, { recursive: true })
    repo = path.join(root, REPO_NAME)
    git(repo, ["remote", "set-url", "origin", path.join(root, "origin.git")])
  })

  afterEach(() => rmRobust(root))

  it("读到当前分支、全部分支（本地在前，当前的最前）、只在远程有的分支；干净仓库没有改动", async () => {
    const s = await state()
    expect(s.current).toBe("main")
    expect(s.detached).toBe(false)
    expect(s.dirty).toBe(0)
    expect(s.inProgress).toBeUndefined()
    expect(sameChatDir(s.toplevel, fs.realpathSync.native(repo))).toBe(true)

    const names = s.branches.map((b) => `${b.kind}:${b.name}`)
    expect(names[0]).toBe("local:main")
    expect(s.branches[0].current).toBe(true)
    expect(names).toEqual(expect.arrayContaining(["local:feature/a", "local:feature/中文", "remote:release/1.0"]))
    // origin/main、origin/feature 之类本地已有的不重复列，origin/HEAD 不列
    expect(names.filter((n) => n.endsWith(":main"))).toEqual(["local:main"])
    expect(names.some((n) => n.endsWith("HEAD"))).toBe(false)
    expect(s.branches.find((b) => b.name === "release/1.0")).toMatchObject({ kind: "remote", remote: "origin" })
  })

  it("从子目录读也是整个仓库的分支", async () => {
    fs.mkdirSync(path.join(repo, "sub"))
    expect((await state(path.join(repo, "sub"))).current).toBe("main")
  })

  it("只数已跟踪文件的改动；新建的未跟踪文件不影响切分支，不算", async () => {
    fs.writeFileSync(path.join(repo, "README.md"), "changed\n")
    fs.writeFileSync(path.join(repo, "untracked.txt"), "x\n")
    expect((await state()).dirty).toBe(1)
  })

  it("切到本地分支（包括非 ASCII 的分支名）", async () => {
    expect(await switchBranch(repo, { name: "feature/a", kind: "local" })).toEqual({ ok: true, current: "feature/a" })
    expect(head()).toBe("feature/a")
    expect(await switchBranch(repo, { name: "feature/中文", kind: "local" })).toEqual({ ok: true, current: "feature/中文" })
    expect(head()).toBe("feature/中文")
    expect((await state()).current).toBe("feature/中文")
  })

  it("切到只在远程有的分支：建同名本地分支并跟踪远程，之后它就是本地分支了", async () => {
    expect(await switchBranch(repo, { name: "release/1.0", kind: "remote", remote: "origin" })).toEqual({ ok: true, current: "release/1.0" })
    expect(git(repo, ["rev-parse", "--abbrev-ref", "release/1.0@{upstream}"])).toBe("origin/release/1.0")
    expect(fs.existsSync(path.join(repo, "release.txt"))).toBe(true)
    const again = await state()
    expect(again.branches.find((b) => b.name === "release/1.0")).toMatchObject({ kind: "local", current: true })
  })

  it("已经在这个分支上：什么都不做，也算成功", async () => {
    expect(await switchBranch(repo, { name: "main", kind: "local" })).toEqual({ ok: true, current: "main" })
  })

  it("有未提交的改动、但和目标分支不冲突：改动带到新分支", async () => {
    fs.writeFileSync(path.join(repo, "notes.txt"), "n\n")
    git(repo, ["add", "notes.txt"])
    expect(await switchBranch(repo, { name: "feature/中文", kind: "local" })).toEqual({ ok: true, current: "feature/中文" })
    expect(git(repo, ["status", "--porcelain"])).toContain("notes.txt")
  })

  it("改动会被目标分支覆盖：拒绝，原因点名文件，留在原分支，改动原样还在", async () => {
    fs.writeFileSync(path.join(repo, "README.md"), "my local edit\n")
    const r = await switchBranch(repo, { name: "feature/a", kind: "local" })
    expect(r).toEqual({ ok: false, error: "有未提交的改动会被目标分支覆盖（README.md），请先提交或暂存" })
    expect(head()).toBe("main")
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf-8")).toBe("my local edit\n")
  })

  it("分支已在别的工作目录检出：列表里标出位置，切换被拒绝且不动仓库", async () => {
    const wt = path.join(root, "wt")
    git(repo, ["worktree", "add", wt, "feature/a"])
    const s = await state()
    const a = s.branches.find((b) => b.name === "feature/a")
    expect(a?.checkedOutAt && sameChatDir(a.checkedOutAt, fs.realpathSync.native(wt))).toBe(true)
    // 自己这个目录检出的分支不算「在别处检出」
    expect(s.branches.find((b) => b.name === "main")?.checkedOutAt).toBeUndefined()

    const r = await switchBranch(repo, { name: "feature/a", kind: "local" })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("已在另一个工作目录检出")
    expect(head()).toBe("main")
  })

  it("目标不在分支列表里一律不交给 git：不存在的分支、伪装成选项的参数、类型对不上的分支", async () => {
    for (const target of [
      { name: "nope", kind: "local" as const },
      { name: "--force", kind: "local" as const },
      { name: "-b", kind: "remote" as const, remote: "origin" },
      { name: "feature/a", kind: "remote" as const, remote: "origin" },
      { name: "release/1.0", kind: "remote" as const, remote: "other" },
      { name: "release/1.0", kind: "local" as const },
    ]) {
      const r = await switchBranch(repo, target)
      expect(r, JSON.stringify(target)).toEqual({ ok: false, error: "分支不存在（可能刚被删除），请重新打开分支列表" })
    }
    expect(head()).toBe("main")
  })

  it("游离 HEAD：当前显示成 HEAD(短哈希)，可以切回某个分支", async () => {
    git(repo, ["checkout", "--detach"])
    const sha = git(repo, ["rev-parse", "--short", "HEAD"])
    const s = await state()
    expect(s.detached).toBe(true)
    expect(s.current).toBe(`HEAD(${sha})`)
    expect(s.branches.some((b) => b.current)).toBe(false)
    expect(await switchBranch(repo, { name: "feature/a", kind: "local" })).toEqual({ ok: true, current: "feature/a" })
  })

  it("rebase、合并之类做到一半：读得到原因，切换被拒绝", async () => {
    fs.mkdirSync(path.join(repo, ".git", "rebase-merge"))
    const s = await state()
    expect(s.inProgress).toContain("rebase")
    const r = await switchBranch(repo, { name: "feature/a", kind: "local" })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("rebase")
    expect(head()).toBe("main")
  })

  it("不是 git 仓库的目录：读和切都给出原因", async () => {
    const plain = path.join(root, "plain")
    fs.mkdirSync(plain)
    expect(await readBranchState(plain)).toEqual({ ok: false, error: "这个目录不是 git 仓库" })
    expect(await switchBranch(plain, { name: "main", kind: "local" })).toEqual({ ok: false, error: "这个目录不是 git 仓库" })
  })
})
