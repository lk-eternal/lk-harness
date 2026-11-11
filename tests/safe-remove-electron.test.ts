import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * 在 Electron 自带的 Node 里验证「删链接不会越界」。
 *
 * 背景：Electron 41（Node 24.14）里，fs.rmSync(链接, { recursive: true }) 会顺着链接把原目录的内容删光，
 * 只留一个空文件夹。设置页和 manage_skills 删 Skill 曾因此把 ~/.agents/skills 里 40 个 Skill 的内容删没了，
 * 只剩空壳。vitest 跑在普通 Node 上，那里 rmSync 是安全的，所以别的测试都抓不到。
 *
 * 做法：把 tests/helpers/safe-remove-driver.ts 连同被测模块打成一个 CJS，用 ELECTRON_RUN_AS_NODE=1 交给
 * Electron 的可执行文件跑（应用的 daemon 就是这样起的），读它打印的观察结果。
 * 没装 Electron 二进制（比如 CI 只装了部分依赖）就跳过。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function electronBinary(): string | null {
  try {
    const p: unknown = createRequire(import.meta.url)("electron")
    return typeof p === "string" && fs.existsSync(p) ? p : null
  } catch {
    return null
  }
}

const electron = electronBinary()

interface Observed {
  node: string
  electron: string | null
  platform: string
  cannotCreateLinks?: boolean
  naiveRmSyncEmptiedTarget?: boolean
  topLink: { result: { ok: boolean; kind?: string }; linkGone: boolean; skillMd: string | null; script: string | null }
  nestedLink: { result: { ok: boolean; kind?: string }; skillGone: boolean; precious: string | null }
  adminLink: { result: { ok: boolean; message?: string }; linkGone: boolean; skillMd: string | null; script: string | null }
  adminNested: { result: { ok: boolean }; skillGone: boolean; precious: string | null }
}

let work: string
let observed: Observed | null = null
let stderr = ""

beforeAll(async () => {
  if (!electron) return
  work = fs.mkdtempSync(path.join(os.tmpdir(), "safe-remove-electron-"))
  const bundle = path.join(work, "driver.cjs")
  await build({
    entryPoints: [path.join(ROOT, "tests/helpers/safe-remove-driver.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "silent",
  })
  const sandbox = path.join(work, "sandbox")
  fs.mkdirSync(sandbox, { recursive: true })
  const r = spawnSync(electron, [bundle, sandbox], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf-8",
    timeout: 60_000,
  })
  // 超时、起不来也要报出来，不能被当成「没有可验证的环境」悄悄跳过
  stderr = r.stderr || (r.status === 0 ? "" : `退出码 ${r.status} ${r.error ? String(r.error) : ""}`.trim())
  if (r.status === 0) {
    const parsed = JSON.parse(r.stdout) as Observed
    observed = parsed.cannotCreateLinks ? null : parsed
  }
}, 120_000)

afterAll(async () => {
  if (work) await fs.promises.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe.skipIf(!electron)("Electron 的 Node 里删链接不越界", () => {
  it("驱动脚本在 Electron 里跑成功（拿到了观察结果）", (ctx) => {
    if (!observed) {
      // 建不了链接的环境（没有权限）没法验证，别当成通过
      if (!stderr) return ctx.skip()
      throw new Error(`驱动脚本失败：${stderr}`)
    }
    expect(observed.electron).toBeTruthy()
  })

  // 前提：确实是 rmSync 会越界。若哪天 Electron 升级后这条变红，说明上游修好了，
  // 可以删掉这一条；下面其余断言仍然要留着，防止以后又有人改回 rmSync。
  it.skipIf(process.platform !== "win32")("前提（Windows）：直接用 fs.rmSync 删链接，原目录的内容会被带走", (ctx) => {
    if (!observed) return ctx.skip()
    expect(observed.naiveRmSyncEmptiedTarget).toBe(true)
  })

  it("removeNoFollow 删链接：只删链接，原目录的文件和脚本都在", (ctx) => {
    if (!observed) return ctx.skip()
    expect(observed.topLink.result).toEqual({ ok: true, kind: "link" })
    expect(observed.topLink.linkGone).toBe(true)
    expect(observed.topLink.skillMd).toBe("原件")
    expect(observed.topLink.script).toBe("原件脚本")
  })

  it("removeNoFollow 删文件夹：里面嵌套的链接指向的地方不动", (ctx) => {
    if (!observed) return ctx.skip()
    expect(observed.nestedLink.result).toEqual({ ok: true, kind: "dir" })
    expect(observed.nestedLink.skillGone).toBe(true)
    expect(observed.nestedLink.precious).toBe("别删我")
  })

  it("manage_skills 删链接过来的 Skill：原目录不能丢", (ctx) => {
    if (!observed) return ctx.skip()
    expect(observed.adminLink.result.ok).toBe(true)
    expect(observed.adminLink.result.message).toContain("只删了链接")
    expect(observed.adminLink.linkGone).toBe(true)
    expect(observed.adminLink.skillMd).toBe("原件")
    expect(observed.adminLink.script).toBe("原件脚本")
  })

  it("manage_skills 删普通 Skill：它里面嵌套的链接指向的地方不动", (ctx) => {
    if (!observed) return ctx.skip()
    expect(observed.adminNested.result.ok).toBe(true)
    expect(observed.adminNested.skillGone).toBe(true)
    expect(observed.adminNested.precious).toBe("别删我")
  })
})
