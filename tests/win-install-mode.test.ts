import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { APP_ID, detectPerUserInstall, nsisInstallGuid, uuidV5, type RegQuery } from "../electron/win-install-mode"

const root = path.resolve(__dirname, "..")

describe("uuidV5 / nsisInstallGuid（和 electron-builder 派生的安装 GUID 一致）", () => {
  it("UUID v5 的标准测试向量（RFC 4122 命名空间 DNS + python.org）", () => {
    expect(uuidV5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d")
  })

  it("本应用的安装 GUID：和真实安装机器上注册表里的 Software\\<GUID> 一致", () => {
    // 这个值取自装了 LK Harness 的机器：HKCU\Software\a98e8260-5633-5bc0-ad78-a21e091e3d4a\InstallLocation
    expect(nsisInstallGuid("com.lk-harness.desktop")).toBe("a98e8260-5633-5bc0-ad78-a21e091e3d4a")
  })

  it("代码里的 appId 和 electron-builder.yml 一致；配置里没有单独指定 NSIS guid（指定了 GUID 就不是派生的了）", () => {
    const yml = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf-8")
    const appId = /^appId:\s*(\S+)\s*$/m.exec(yml)?.[1]
    expect(appId).toBe(APP_ID)
    expect(yml).not.toMatch(/^\s*guid\s*:/m)
  })
})

describe("detectPerUserInstall（只有确认是「仅当前用户」安装才返回 true）", () => {
  const guid = nsisInstallGuid()
  const queryWith = (hkcu: number | null, hklm: number | null): { query: RegQuery; calls: string[] } => {
    const calls: string[] = []
    const query: RegQuery = async (key, value) => {
      calls.push(`${key} /v ${value}`)
      return { code: key.startsWith("HKCU") ? hkcu : hklm }
    }
    return { query, calls }
  }

  it("HKCU 里有安装位置、HKLM 里没有：确认是仅当前用户安装", async () => {
    const { query, calls } = queryWith(0, 1)
    await expect(detectPerUserInstall({ platform: "win32", query })).resolves.toBe(true)
    expect(calls.sort()).toEqual([
      `HKCU\\Software\\${guid} /v InstallLocation`,
      `HKLM\\Software\\${guid} /v InstallLocation`,
    ])
  })

  it("HKLM 里有（所有用户安装）：不是；HKCU 和 HKLM 都有也不算确认", async () => {
    await expect(detectPerUserInstall({ platform: "win32", query: queryWith(1, 0).query })).resolves.toBe(false)
    await expect(detectPerUserInstall({ platform: "win32", query: queryWith(0, 0).query })).resolves.toBe(false)
  })

  it("两边都没有（便携版、手动解压的目录）：没确认", async () => {
    await expect(detectPerUserInstall({ platform: "win32", query: queryWith(1, 1).query })).resolves.toBe(false)
  })

  it("reg.exe 没能跑（退出码取不到）：没确认，哪怕另一边看起来像", async () => {
    await expect(detectPerUserInstall({ platform: "win32", query: queryWith(null, 1).query })).resolves.toBe(false)
    await expect(detectPerUserInstall({ platform: "win32", query: queryWith(0, null).query })).resolves.toBe(false)
    await expect(detectPerUserInstall({ platform: "win32", query: queryWith(null, null).query })).resolves.toBe(false)
  })

  it("其它非 0/1 的退出码（拒绝访问等）：没确认", async () => {
    await expect(detectPerUserInstall({ platform: "win32", query: queryWith(0, 5).query })).resolves.toBe(false)
  })

  it("查询抛异常：没确认，不向外抛", async () => {
    const query: RegQuery = vi.fn(async () => {
      throw new Error("boom")
    })
    await expect(detectPerUserInstall({ platform: "win32", query })).resolves.toBe(false)
  })

  it("不是 Windows：直接 false，也不去查注册表", async () => {
    const { query, calls } = queryWith(0, 1)
    await expect(detectPerUserInstall({ platform: "darwin", query })).resolves.toBe(false)
    await expect(detectPerUserInstall({ platform: "linux", query })).resolves.toBe(false)
    expect(calls).toEqual([])
  })

  it("换一个 appId 查的是另一个键", async () => {
    const { query, calls } = queryWith(0, 1)
    await detectPerUserInstall({ platform: "win32", appId: "com.example.other", query })
    expect(calls.every((c) => !c.includes(guid))).toBe(true)
  })
})

// 真去跑 reg.exe：只在 Windows 上验证「退出码 0 = 有、1 = 没有」这条假设，非 Windows 跳过
describe.runIf(process.platform === "win32")("queryRegistry（真实 reg.exe，只看退出码）", () => {
  it("存在的键退出码 0，不存在的键退出码 1，提示文字不参与判断", async () => {
    const { queryRegistry } = await import("../electron/win-install-mode")
    await expect(queryRegistry("HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion", "ProductName")).resolves.toEqual({ code: 0 })
    // 不存在的 GUID：reg.exe 的报错文字跟着系统语言走，只看数字退出码
    const missing = await queryRegistry("HKCU\\Software\\00000000-0000-5000-8000-000000000000", "InstallLocation")
    expect(missing).toEqual({ code: 1 })
  })
})
