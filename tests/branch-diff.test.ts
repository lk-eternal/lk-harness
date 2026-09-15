import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { buildDiffData, injectDiffData } from "../src/shared/branch-diff.js"

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || "git failed")
  return (r.stdout || "").trim()
}

const tmpRoots: string[] = []
afterEach(() => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()!
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 } as fs.RmOptions)
    } catch { /* ignore: CI 临时目录由 runner 回收 */ }
  }
})

/** base commit → 改 a.txt → head commit */
function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "diff-t-"))
  tmpRoots.push(repo)
  git(repo, ["init"])
  git(repo, ["config", "user.email", "t@t.com"])
  git(repo, ["config", "user.name", "t"])
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n2\n3\n", "utf-8")
  git(repo, ["add", "."])
  git(repo, ["commit", "-m", "base"])
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n2x\n3\n4\n", "utf-8")
  git(repo, ["add", "."])
  git(repo, ["commit", "-m", "head"])
  return repo
}

describe("buildDiffData", () => {
  it("base..HEAD 产出文件条目与 hunks/fullHunks", () => {
    const repo = initRepo()
    const d = buildDiffData({ repoPath: repo, baseRef: "HEAD~1" })
    expect(d.file_count).toBe(1)
    expect(d.commit_count).toBe(1)
    expect(d.files[0].path).toBe("a.txt")
    expect(d.files[0].add).toBeGreaterThan(0)
    expect(d.files[0].del).toBeGreaterThan(0)
    expect(d.files[0].hunks.length).toBeGreaterThan(0)
    expect(d.files[0].fullHunks.length).toBeGreaterThan(0)
    expect(d.stat).toContain("a.txt")
  })

  it("子目录传入也能 resolve 到仓库根", () => {
    const repo = initRepo()
    const sub = path.join(repo, "sub")
    fs.mkdirSync(sub)
    const d = buildDiffData({ repoPath: sub, baseRef: "HEAD~1" })
    expect(d.file_count).toBe(1)
  })

  it("非 git 目录明确失败，不产空壳", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-n-"))
    tmpRoots.push(dir)
    expect(() => buildDiffData({ repoPath: dir, baseRef: "HEAD" })).toThrow(/git/i)
  })

  it("不存在的 ref 明确失败", () => {
    const repo = initRepo()
    expect(() => buildDiffData({ repoPath: repo, baseRef: "no-such-ref-xyz" })).toThrow(/ref|rev-parse|不存在/i)
  })

  it("无变更明确失败", () => {
    const repo = initRepo()
    expect(() => buildDiffData({ repoPath: repo, baseRef: "HEAD" })).toThrow(/无变更/i)
  })

  it("超限失败并说明（不 silent 截断）", () => {
    const repo = initRepo()
    expect(() => buildDiffData({ repoPath: repo, baseRef: "HEAD~1", maxFiles: 0 })).toThrow(/超限/i)
  })
})

describe("injectDiffData", () => {
  it("只替换 #diff-data，不动其余", () => {
    const html = `<html><body><script id="diff-data" type="application/json">[]</script><p>keep</p></body></html>`
    const out = injectDiffData(html, { files: [], file_count: 0, commit_count: 0 } as any)
    expect(out).toContain("keep")
    expect(out).toContain(`"file_count":0`)
  })

  it("缺占位时抛错", () => {
    expect(() => injectDiffData("<html></html>", { files: [] } as any)).toThrow(/diff-data/)
  })
})
