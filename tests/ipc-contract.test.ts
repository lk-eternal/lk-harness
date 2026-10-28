import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * preload 暴露给界面的每个 IPC 通道，主进程都得有对应的 handler；界面类型声明里也得有对应的方法。
 * 少了任何一处，调用要么永远挂着（invoke 没有 handler 会抛 "No handler registered"），要么 TS 通过不了。
 * 这类接线没法靠单测覆盖业务逻辑，至少把「名字对得上」钉住。
 */

const ROOT = path.resolve(__dirname, "..")
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8")

function electronSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (full.endsWith(".ts")) out.push(full)
    }
  }
  walk(path.join(ROOT, "electron"))
  return out
}

const preload = read("electron/preload.ts")
const invoked = [...preload.matchAll(/ipcRenderer\.(?:invoke|sendSync)\(\s*"([^"]+)"/g)].map((m) => m[1])
const handled = new Set(
  electronSources().flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/ipcMain\.(?:handle|on)\(\s*"([^"]+)"/g)].map((m) => m[1])),
)

describe("IPC 接线", () => {
  it("preload 里调用的每个通道，主进程都注册了 handler", () => {
    expect(invoked.length).toBeGreaterThan(100)
    expect(invoked.filter((c) => !handled.has(c))).toEqual([])
  })

  it("会话管理页的 6 个通道：preload 和主进程一一对应", () => {
    const pre = invoked.filter((c) => c.startsWith("session-manager:")).sort()
    const main = [...handled].filter((c) => c.startsWith("session-manager:")).sort()
    expect(pre).toEqual([
      "session-manager:cleanup-preview",
      "session-manager:cleanup-run",
      "session-manager:delete",
      "session-manager:list",
      "session-manager:reset",
      "session-manager:restore-default",
    ])
    expect(main).toEqual(pre)
  })

  it("会话管理页的方法在 preload 和界面类型声明里都有，且名字一致", () => {
    const envDts = read("src/renderer/env.d.ts")
    for (const name of ["listManagedSessions", "restoreSessionDefault", "resetManagedSession", "deleteManagedSession", "previewSessionCleanup", "runSessionCleanup"]) {
      expect(preload, `preload 缺 ${name}`).toMatch(new RegExp(`\\b${name}:\\s*\\(`))
      expect(envDts, `env.d.ts 缺 ${name}`).toMatch(new RegExp(`\\b${name}\\(`))
    }
  })

  it("每个会话管理页方法调用的是它对应的通道（不是串了线）", () => {
    const expectChannel: Record<string, string> = {
      listManagedSessions: "session-manager:list",
      restoreSessionDefault: "session-manager:restore-default",
      resetManagedSession: "session-manager:reset",
      deleteManagedSession: "session-manager:delete",
      previewSessionCleanup: "session-manager:cleanup-preview",
      runSessionCleanup: "session-manager:cleanup-run",
    }
    for (const [method, channel] of Object.entries(expectChannel)) {
      // 取这个方法自己的那一段（到下一个顶层属性为止），再看它调用的通道
      const start = preload.indexOf(`\n  ${method}: `)
      expect(start, `preload 缺 ${method}`).toBeGreaterThan(-1)
      const rest = preload.slice(start + 1)
      const next = rest.slice(1).search(/\n  \w+: /)
      const block = next < 0 ? rest : rest.slice(0, next + 1)
      expect([...block.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1]), method).toEqual([channel])
    }
  })
})
