import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  passwd: "/bin/zsh" as string | null,
  passwdThrows: false,
  onDisk: new Set<string>(),
}))

vi.mock("node:os", async (orig) => {
  const real = await orig<typeof import("node:os")>()
  return {
    ...real,
    default: real,
    userInfo: () => {
      if (h.passwdThrows) throw new Error("no passwd entry")
      return { shell: h.passwd }
    },
  }
})
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>()
  return { ...real, default: real, existsSync: (p: string) => h.onDisk.has(String(p)) }
})

import { defaultShellPathDeps } from "../electron/shell-path"

describe("defaultShellPathDeps：开哪个 login shell", () => {
  const savedShell = process.env.SHELL
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platform, value })

  beforeEach(() => {
    h.passwd = "/bin/zsh"
    h.passwdThrows = false
    h.onDisk = new Set(["/bin/zsh", "/bin/bash"])
    setPlatform("darwin")
  })
  afterEach(() => {
    Object.defineProperty(process, "platform", platform)
    if (savedShell === undefined) delete process.env.SHELL
    else process.env.SHELL = savedShell
  })

  it("用户 chsh -s /bin/zsh 之后：图形应用的 $SHELL 还是旧的 /bin/bash，要以账号记录里的 zsh 为准", () => {
    process.env.SHELL = "/bin/bash"
    expect(defaultShellPathDeps().shell).toBe("/bin/zsh")
  })

  it("账号记录和 $SHELL 一致就是它", () => {
    h.passwd = "/bin/bash"
    process.env.SHELL = "/bin/bash"
    expect(defaultShellPathDeps().shell).toBe("/bin/bash")
  })

  it("读不到账号记录：退到 $SHELL", () => {
    h.passwdThrows = true
    process.env.SHELL = "/bin/bash"
    expect(defaultShellPathDeps().shell).toBe("/bin/bash")
  })

  it("账号记录是 nologin 这类不能用的：退到 $SHELL", () => {
    h.passwd = "/usr/sbin/nologin"
    h.onDisk.add("/usr/sbin/nologin")
    process.env.SHELL = "/bin/bash"
    expect(defaultShellPathDeps().shell).toBe("/bin/bash")
  })

  it("macOS 上两边都没有：用系统自带的 zsh；zsh 也没有就用 bash", () => {
    h.passwdThrows = true
    delete process.env.SHELL
    expect(defaultShellPathDeps().shell).toBe("/bin/zsh")
    h.onDisk = new Set(["/bin/bash"])
    expect(defaultShellPathDeps().shell).toBe("/bin/bash")
  })

  it("Linux 上两边都没有：不猜，没有 shell 可开（只用兜底目录）", () => {
    setPlatform("linux")
    h.passwdThrows = true
    delete process.env.SHELL
    expect(defaultShellPathDeps().shell).toBeUndefined()
  })
})
