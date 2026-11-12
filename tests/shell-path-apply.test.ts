import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyShellPath, probeLoginShellPath, type ShellPathDeps } from "../electron/shell-path"
const HOME = "/Users/colde"
const DOCK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
const NVM_BIN = `${HOME}/.nvm/versions/node/v22.23.2/bin`

/** 假环境：从 Dock 启动的 macOS（PATH 只有系统最小集合），磁盘上只存在 exists 里列的目录 */
function makeDeps(over: Partial<ShellPathDeps> & { existing?: string[]; nvmVersions?: string[] } = {}): ShellPathDeps & { probed: string[] } {
  const existing = new Set(over.existing ?? ["/opt/homebrew/bin", "/usr/local/bin", "/bin/zsh"])
  const probed: string[] = []
  return {
    env: { PATH: DOCK_PATH },
    platform: "darwin",
    home: HOME,
    shell: "/bin/zsh",
    exists: (p) => existing.has(p),
    listDir: (p) => (p === `${HOME}/.nvm/versions/node` ? over.nvmVersions ?? [] : []),
    probeShellPath: async (s) => { probed.push(s); return undefined },
    ...over,
    probed,
  }
}

describe("applyShellPath", () => {
  it("Windows 不需要补：PATH 原样，也不开 shell", async () => {
    const deps = makeDeps({ platform: "win32", env: { PATH: "C:\\Windows" } })
    const r = await applyShellPath(deps)
    expect(r).toEqual({ applied: false, shellOk: false, added: [] })
    expect(deps.env.PATH).toBe("C:\\Windows")
    expect(deps.probed).toEqual([])
  })

  it("用户的情形：终端里 node 能用，应用里找不到——login shell 的 PATH 排最前，系统目录保留", async () => {
    const deps = makeDeps({
      existing: ["/opt/homebrew/bin", "/usr/local/bin", "/bin/zsh", NVM_BIN],
      nvmVersions: ["v20.1.0", "v22.23.2", "default"],
      probeShellPath: async () => `${NVM_BIN}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    })
    const r = await applyShellPath(deps)
    const dirs = deps.env.PATH!.split(":")
    expect(dirs[0]).toBe(NVM_BIN)
    expect(dirs.indexOf("/opt/homebrew/bin")).toBe(1)
    for (const sys of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) expect(dirs, sys).toContain(sys)
    expect(new Set(dirs).size).toBe(dirs.length)
    expect(r.applied).toBe(true)
    expect(r.shellOk).toBe(true)
    expect(r.added).toEqual(expect.arrayContaining([NVM_BIN, "/opt/homebrew/bin"]))
  })

  it("兜底目录马上生效：不用等 login shell 跑完，Homebrew 的 node 就已经在 PATH 里", async () => {
    let finishProbe!: (v: string | undefined) => void
    const deps = makeDeps({ probeShellPath: () => new Promise((resolve) => { finishProbe = resolve }) })
    const pending = applyShellPath(deps)
    // 此时 login shell 还没返回
    expect(deps.env.PATH!.split(":")).toContain("/opt/homebrew/bin")
    expect(deps.env.PATH!.split(":")).toContain("/usr/local/bin")
    finishProbe(`${NVM_BIN}:/usr/bin`)
    const r = await pending
    expect(deps.env.PATH!.split(":")[0]).toBe(NVM_BIN)
    expect(r.shellOk).toBe(true)
  })

  it("login shell 读不到（超时、报错）：不抛错，仍然用上兜底目录，shellOk 为 false", async () => {
    for (const probe of [async () => undefined, async () => { throw new Error("boom") }] as ShellPathDeps["probeShellPath"][]) {
      const deps = makeDeps({ probeShellPath: probe })
      const r = await applyShellPath(deps)
      expect(r.shellOk).toBe(false)
      expect(r.applied).toBe(true)
      expect(deps.env.PATH).toBe(`${DOCK_PATH}:/opt/homebrew/bin:/usr/local/bin`)
    }
  })

  it("不存在的目录不加（没装 Homebrew 的机器上 PATH 里不会多出 /opt/homebrew/bin）", async () => {
    const deps = makeDeps({ existing: ["/bin/zsh"] })
    await applyShellPath(deps)
    expect(deps.env.PATH).toBe(DOCK_PATH)
  })

  it("nvm 兜底：login shell 没读到时，用 nvm 里最新的版本", async () => {
    const deps = makeDeps({ existing: [NVM_BIN, "/bin/zsh"], nvmVersions: ["v18.0.0", "v22.23.2"] })
    await applyShellPath(deps)
    expect(deps.env.PATH!.split(":")).toContain(NVM_BIN)
  })

  it("shell 不支持（tcsh）、受支持但磁盘上没有（/bin/bash）、没取到：都不去开 shell，只用兜底目录", async () => {
    for (const shell of ["/bin/tcsh", "/bin/bash", undefined]) {
      const deps = makeDeps({ shell, existing: ["/opt/homebrew/bin", "/bin/tcsh"] })
      const r = await applyShellPath(deps)
      expect(deps.probed, String(shell)).toEqual([])
      expect(r.shellOk).toBe(false)
      expect(deps.env.PATH).toContain("/opt/homebrew/bin")
    }
  })

  it("从终端启动（PATH 已经完整）：再补一遍也不会重复、不会乱序", async () => {
    const full = `${NVM_BIN}:/opt/homebrew/bin:/usr/local/bin:${DOCK_PATH}`
    const deps = makeDeps({ env: { PATH: full }, probeShellPath: async () => full })
    const r = await applyShellPath(deps)
    expect(deps.env.PATH).toBe(full)
    expect(r.added).toEqual([])
  })

  it("原来 PATH 是空的（极端情况）也能补出东西", async () => {
    const deps = makeDeps({ env: {} })
    await applyShellPath(deps)
    expect(deps.env.PATH).toBe("/opt/homebrew/bin:/usr/local/bin")
  })
})

// 真的开一个 login shell：证明 `-ilc` + 标记 这套在真 shell 上能取到 rc 文件里配的 PATH，rc 文件的杂音不会干扰，卡住的 rc 会被超时杀掉
const BASH = ["/bin/bash", "/usr/bin/bash"].find((p) => fs.existsSync(p))
describe.skipIf(!BASH || process.platform === "win32")("probeLoginShellPath（真 shell）", () => {
  let home: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "lk-shellpath-"))
    for (const k of ["HOME", "PATH"]) saved[k] = process.env[k]
    process.env.HOME = home
    process.env.PATH = "/usr/bin:/bin"
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("读到 .bash_profile 里加的目录；rc 文件往标准输出打的杂音不影响解析", async () => {
    fs.writeFileSync(path.join(home, ".bash_profile"), `echo "Welcome! PATH=/noise"\nexport PATH="/custom/node/bin:$PATH"\n`)
    const p = await probeLoginShellPath(BASH!, 10_000)
    expect(p).toBeDefined()
    expect(p!.split(":")[0]).toBe("/custom/node/bin")
    expect(p).not.toContain("noise")
  })

  it("rc 文件卡住时到点强杀，返回 undefined，不会一直挂着", async () => {
    fs.writeFileSync(path.join(home, ".bash_profile"), "sleep 30\n")
    const started = Date.now()
    const p = await probeLoginShellPath(BASH!, 600)
    expect(p).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("shell 不存在：返回 undefined，不抛错", async () => {
    await expect(probeLoginShellPath("/no/such/shell", 2_000)).resolves.toBeUndefined()
  })
})
