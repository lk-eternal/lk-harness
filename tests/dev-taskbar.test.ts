import { describe, expect, it } from "vitest"
import { DEV_APP_USER_MODEL_ID, devTaskbarDetails, type DevTaskbarInput } from "../electron/dev-taskbar"

const base: DevTaskbarInput = {
  platform: "win32",
  isPackaged: false,
  execPath: "D:\\workspace\\lk-harness\\node_modules\\electron\\dist\\electron.exe",
  appPath: "D:\\workspace\\lk-harness",
  iconPath: "D:\\workspace\\lk-harness\\resources\\icon.ico",
}

describe("开发模式任务栏身份：不再被开始菜单里的 Electron.lnk 抢走图标", () => {
  it("Windows 开发模式：窗口单独设开发专用 ID 并带上应用图标", () => {
    const d = devTaskbarDetails(base)
    expect(d).not.toBeNull()
    expect(d?.appId).toBe(DEV_APP_USER_MODEL_ID)
    expect(d?.appIconPath).toBe(base.iconPath)
    expect(d?.appIconIndex).toBe(0)
    expect(d?.relaunchDisplayName).toBe("LK Harness (dev)")
  })

  it("开发 ID 不能和安装版、也不能和 Electron 默认 ID 相同，否则会并进别人的任务栏按钮", () => {
    expect(DEV_APP_USER_MODEL_ID).not.toBe("com.lk-harness.desktop")
    expect(DEV_APP_USER_MODEL_ID).not.toBe("electron.app.Electron")
    expect(DEV_APP_USER_MODEL_ID.startsWith("com.lk-harness.desktop")).toBe(true)
  })

  it("打包版、非 Windows 都不设（安装包自带快捷方式和图标，别的平台没有这个概念）", () => {
    expect(devTaskbarDetails({ ...base, isPackaged: true })).toBeNull()
    expect(devTaskbarDetails({ ...base, platform: "darwin" })).toBeNull()
    expect(devTaskbarDetails({ ...base, platform: "linux" })).toBeNull()
  })

  it("重启命令：路径里有空格要加引号，没有就不加", () => {
    const plain = devTaskbarDetails(base)
    expect(plain?.relaunchCommand).toBe(`${base.execPath} ${base.appPath}`)
    const spaced = devTaskbarDetails({ ...base, appPath: "D:\\my work\\lk-harness" })
    expect(spaced?.relaunchCommand).toBe(`${base.execPath} "D:\\my work\\lk-harness"`)
  })

  it("npm run dev 默认的 profile=dev：用基础 ID（不拼出 .dev.dev），重启命令仍带 --profile", () => {
    const dev = devTaskbarDetails({ ...base, profileName: "dev" })
    expect(dev?.appId).toBe(DEV_APP_USER_MODEL_ID)
    expect(dev?.relaunchCommand?.endsWith("--profile=dev")).toBe(true)
    expect(dev?.relaunchDisplayName).toBe("LK Harness [dev]")
  })

  it("其它 profile 用各自的 ID，各占一个任务栏按钮；profile 里的非法字符被滤掉", () => {
    const b = devTaskbarDetails({ ...base, profileName: "beta" })
    expect(b?.appId).toBe(`${DEV_APP_USER_MODEL_ID}.beta`)
    expect(b?.relaunchCommand?.endsWith("--profile=beta")).toBe(true)

    const odd = devTaskbarDetails({ ...base, profileName: "a b/c.d" })
    expect(odd?.appId).toBe(`${DEV_APP_USER_MODEL_ID}.abcd`)
    expect(odd?.appId).not.toMatch(/\s/)
  })

  it("profile 很长也不会超过 AppUserModelID 的 128 字符上限", () => {
    const d = devTaskbarDetails({ ...base, profileName: "x".repeat(300) })
    expect((d?.appId ?? "").length).toBeLessThanOrEqual(128)
  })

  it("profile 全是非法字符时回落到不带后缀的 ID", () => {
    expect(devTaskbarDetails({ ...base, profileName: "///" })?.appId).toBe(DEV_APP_USER_MODEL_ID)
  })
})
