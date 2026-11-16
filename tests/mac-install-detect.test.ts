import * as fs from "node:fs"
import { describe, expect, it } from "vitest"
import {
  classifyBrewListFailure,
  detectMacInstallMethod,
  type BrewListOutcome,
  type MacInstallProbes,
} from "../electron/brew-update"

/** 读源码做接线检查：只有在真实的 macOS 应用里才跑得到的分支，至少守住「分流的顺序」不被改回去 */
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n")

function probes(over: Partial<MacInstallProbes> & { listed?: BrewListOutcome; dirs?: string[] } = {}): {
  p: MacInstallProbes
  listCalls: string[]
} {
  const listCalls: string[] = []
  const { listed = "installed", dirs = ["/opt/homebrew/Caskroom/lk-harness"], ...rest } = over
  return {
    listCalls,
    p: {
      brewPath: "/opt/homebrew/bin/brew",
      cask: "lk-harness",
      isDirectory: (d) => dirs.includes(d),
      listCask: async (brew) => {
        listCalls.push(brew)
        return listed
      },
      ...rest,
    },
  }
}

describe("detectMacInstallMethod：brew 装的走 brew，其余走应用内更新", () => {
  it("brew 登记了 → brew", async () => {
    const { p } = probes()
    const r = await detectMacInstallMethod(p)
    expect(r.method).toBe("brew")
  })

  it("没装 Homebrew → dmg，不去问 brew", async () => {
    const { p, listCalls } = probes({ brewPath: null })
    expect((await detectMacInstallMethod(p)).method).toBe("dmg")
    expect(listCalls).toEqual([])
  })

  it("装了 Homebrew，但没登记 lk-harness（dmg 用户常见）→ dmg，连 brew list 都不用跑", async () => {
    const { p, listCalls } = probes({ dirs: [] })
    const r = await detectMacInstallMethod(p)
    expect(r.method).toBe("dmg")
    expect(r.reason).toContain("没有登记")
    expect(listCalls).toEqual([])
  })

  it("目录在、但 brew 说没装（残留的空目录）→ dmg", async () => {
    const { p } = probes({ listed: "not-installed" })
    const r = await detectMacInstallMethod(p)
    expect(r.method).toBe("dmg")
    expect(r.reason).toContain("残留")
  })

  it("目录在、brew list 没问出结果（超时、brew 坏了）→ 按 brew，不把 brew 用户的应用原地换掉", async () => {
    const { p } = probes({ listed: "unknown" })
    const r = await detectMacInstallMethod(p)
    expect(r.method).toBe("brew")
    expect(r.reason).toContain("没问出结果")
  })

  it("Intel Mac 的 brew 前缀是 /usr/local", async () => {
    const { p, listCalls } = probes({ brewPath: "/usr/local/bin/brew", dirs: ["/usr/local/Caskroom/lk-harness"] })
    expect((await detectMacInstallMethod(p)).method).toBe("brew")
    expect(listCalls).toEqual(["/usr/local/bin/brew"])
    // Apple 芯片前缀下的目录不能当成 Intel 的登记
    const other = probes({ brewPath: "/usr/local/bin/brew", dirs: ["/opt/homebrew/Caskroom/lk-harness"] })
    expect((await detectMacInstallMethod(other.p)).method).toBe("dmg")
  })

  it("判断依据写进 reason，日志里能看出为什么", async () => {
    for (const [over, text] of [
      [{ brewPath: null }, "没有 Homebrew"],
      [{ dirs: [] }, "/opt/homebrew/Caskroom/lk-harness"],
    ] as const) {
      expect((await detectMacInstallMethod(probes(over).p)).reason).toContain(text)
    }
  })
})

describe("classifyBrewListFailure", () => {
  it("退出码 1 是 brew 的「没装」", () => {
    expect(classifyBrewListFailure(Object.assign(new Error("Command failed"), { code: 1 }))).toBe("not-installed")
  })

  it("超时被杀、找不到可执行文件、别的退出码、不是错误对象：都不能当成「没装」", () => {
    expect(classifyBrewListFailure(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("unknown")
    expect(classifyBrewListFailure(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("unknown")
    expect(classifyBrewListFailure(Object.assign(new Error("x"), { code: 2 }))).toBe("unknown")
    expect(classifyBrewListFailure(Object.assign(new Error("x"), { code: null, killed: true }))).toBe("unknown")
    expect(classifyBrewListFailure("boom")).toBe("unknown")
    expect(classifyBrewListFailure(null)).toBe("unknown")
    expect(classifyBrewListFailure(undefined)).toBe("unknown")
  })
})

describe("updater.ts 的接线（读源码）", () => {
  const src = read("electron/updater.ts")

  /** 取一个函数的源码：从 `function name(` 起，到下一个顶层的 `\nfunction` / `\nasync function` / `\nexport` 前 */
  function fn(name: string): string {
    const start = src.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`))
    expect(start, `找不到 ${name}`).toBeGreaterThanOrEqual(0)
    const rest = src.slice(start + 1)
    const end = rest.search(/\n(?:export )?(?:async )?function |\nexport |\n\/\*\*\n/)
    return end < 0 ? rest : rest.slice(0, end)
  }

  it("brew 升级不再 install：dmg 装的用户对它 install 会撞上「应用程序」里已有的同名应用", () => {
    const body = fn("runBrewUpgrade")
    expect(body).toContain('"upgrade"')
    expect(body).not.toMatch(/"install"/)
    expect(body).not.toMatch(/"list"/)
  })

  it("applyMacUpdate：先看有没有准备好的，再识别安装方式，brew 走 brew、dmg 走应用内更新", () => {
    const body = fn("applyMacUpdate")
    const iPrepared = body.indexOf("macPrepared")
    const iDetect = body.indexOf("detectMacInstall()")
    const iBrew = body.indexOf("runBrewUpgrade(")
    const iDmg = body.indexOf("startMacDmgUpdate(")
    expect(iPrepared).toBeGreaterThanOrEqual(0)
    expect(iPrepared).toBeLessThan(iDetect)
    expect(iDetect).toBeLessThan(iBrew)
    expect(iBrew).toBeLessThan(iDmg)
  })

  it("mac 上点更新（设置页和启动弹窗）都走 applyMacUpdate，不再直接 runBrewUpgrade", () => {
    const calls = [...src.matchAll(/runBrewUpgrade\(/g)].length
    // 定义一处、applyMacUpdate 里调用一处
    expect(calls).toBe(2)
    expect([...src.matchAll(/applyMacUpdate\(/g)].length).toBeGreaterThanOrEqual(3)
  })

  it("应用内更新开始前先做完「走不走得通」的检查，再起后台下载", () => {
    const body = fn("startMacDmgUpdate")
    const order = ["macYmlUrl(", "pickMacDmg(", "checkMacInstallTarget(", "runMacDmgJob("].map((s) => body.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it("失败都退回手动下载：检查不过给 downloadUrl，下载或准备失败弹「手动下载」", () => {
    expect(fn("macManualFailure")).toContain("downloadUrl")
    expect(fn("runMacDmgJob")).toContain("showMacManualFallback(")
    expect(fn("installPreparedMacUpdate")).toContain("macManualFailure(")
  })

  it("安装：先启动替换脚本，成功了才退出应用（脚本没启动就退出会白白关掉应用）", () => {
    const body = fn("installPreparedMacUpdate")
    expect(body.indexOf("launchMacSwap(")).toBeGreaterThanOrEqual(0)
    expect(body.indexOf("launchMacSwap(")).toBeLessThan(body.indexOf("app.quit()"))
    // launch 失败的分支在 quit 之前 return
    expect(body.slice(body.indexOf("catch"), body.indexOf("app.quit()"))).toContain("return macManualFailure(")
  })

  it("检查更新：mac 上已经准备好的新版本报 ready（设置页才会出现「立即安装」）", () => {
    expect(src).toMatch(/process\.platform === "darwin" && macPrepared && semver\.gte\(macPrepared\.version, rel\.version\)/)
  })

  it("「更新已就绪」的确认：mac 上装的是准备好的 dmg 更新，不是 electron-updater", () => {
    const body = fn("promptInstallDownloaded")
    expect(body).toContain("installPreparedMacUpdate()")
    expect(body.indexOf("installPreparedMacUpdate()")).toBeLessThan(body.indexOf("quitAndInstall("))
  })

  it("启动时善后只在打包后的 mac 上跑", () => {
    expect(src).toMatch(/app\.isPackaged && process\.platform === "darwin"[\s\S]{0,200}macStartupHousekeeping\(\)/)
  })

  it("测试更新源只认 http(s) 地址，不设就是 null（正式环境不受影响）", () => {
    expect(fn("macUpdateFeed")).toContain("LK_MAC_UPDATE_FEED")
    expect(fn("macUpdateFeed")).toMatch(/https\?/)
  })
})
