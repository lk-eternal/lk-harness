import { describe, expect, it } from "vitest"
import {
  SHELL_ENV_DELIMITER,
  buildPath,
  fallbackDirCandidates,
  newestVersionDir,
  parseShellEnvPath,
  splitPathList,
  supportsLoginShellProbe,
} from "../src/shared/shell-path"

/** 从 Dock 启动的 macOS 应用拿到的 PATH：只有系统最小集合，没有 Homebrew，更没有 nvm */
const DOCK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

describe("splitPathList", () => {
  it("去掉空段和末尾斜杠，根目录保留", () => {
    expect(splitPathList("/usr/bin::/opt/homebrew/bin/:/")).toEqual(["/usr/bin", "/opt/homebrew/bin", "/"])
    expect(splitPathList("")).toEqual([])
    expect(splitPathList(undefined)).toEqual([])
  })
  it("目录名里有空格的原样保留", () => {
    expect(splitPathList("/Users/a b/bin:/usr/bin")).toEqual(["/Users/a b/bin", "/usr/bin"])
  })
})

describe("buildPath", () => {
  it("shell 的排最前，应用原有的接着，兜底最后；重复的只留第一次出现的位置", () => {
    const merged = buildPath({
      shell: "/Users/x/.nvm/versions/node/v22.23.2/bin:/opt/homebrew/bin:/usr/bin:/bin",
      current: DOCK_PATH,
      fallback: ["/opt/homebrew/bin", "/usr/local/bin"],
    })
    expect(merged.split(":")).toEqual([
      "/Users/x/.nvm/versions/node/v22.23.2/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/usr/local/bin",
    ])
  })
  it("没有 shell 的 PATH 时：当前 PATH 在前，兜底目录补在后面", () => {
    expect(buildPath({ current: DOCK_PATH, fallback: ["/opt/homebrew/bin"] })).toBe(`${DOCK_PATH}:/opt/homebrew/bin`)
  })
  it("什么都没有是空串，不会冒出多余的冒号", () => {
    expect(buildPath({})).toBe("")
    expect(buildPath({ shell: "", current: "::" })).toBe("")
  })
  it("Windows 风格的分隔符也能用", () => {
    expect(buildPath({ current: "C:\\a;C:\\b", fallback: ["C:\\b", "C:\\c"] }, ";")).toBe("C:\\a;C:\\b;C:\\c")
  })
})

describe("parseShellEnvPath", () => {
  const D = SHELL_ENV_DELIMITER
  it("只取两个标记之间 env 输出里的 PATH，rc 文件自己打的内容不混进来", () => {
    const out = `Welcome to zsh!\nnvm: using v22\n${D}HOME=/Users/x\nPATH=/a/bin:/b/bin\nMANPATH=/m\nXDG_PATH=/no\n${D}bye\n`
    expect(parseShellEnvPath(out)).toBe("/a/bin:/b/bin")
  })
  it("rc 文件里的输出里就算有 PATH= 开头的行，也在标记之外，不算", () => {
    const out = `PATH=/fake\n${D}PATH=/real\n${D}`
    expect(parseShellEnvPath(out)).toBe("/real")
  })
  it("换行是 CRLF 也能读", () => {
    expect(parseShellEnvPath(`${D}HOME=/h\r\nPATH=/a:/b\r\n${D}`)).toBe("/a:/b")
  })
  it("shell 没跑完（缺结尾标记）、一个标记都没有、没有 PATH 行、PATH 是空的：都是 undefined", () => {
    expect(parseShellEnvPath(`${D}PATH=/a`)).toBeUndefined()
    expect(parseShellEnvPath("PATH=/a")).toBeUndefined()
    expect(parseShellEnvPath(`${D}HOME=/h\n${D}`)).toBeUndefined()
    expect(parseShellEnvPath(`${D}PATH=\n${D}`)).toBeUndefined()
    expect(parseShellEnvPath("")).toBeUndefined()
  })
})

describe("newestVersionDir", () => {
  it("按数字比版本，不按字符串（v22.10.0 比 v22.9.0 新，v9 比 v22 旧）", () => {
    expect(newestVersionDir(["v22.9.0", "v22.10.0", "v9.11.2"])).toBe("v22.10.0")
    expect(newestVersionDir(["v9.11.2", "v22.1.0"])).toBe("v22.1.0")
  })
  it("忽略不像版本号的目录名（default、system），一个版本都没有就是 undefined", () => {
    expect(newestVersionDir(["default", "v20.1.0", "system"])).toBe("v20.1.0")
    expect(newestVersionDir(["default"])).toBeUndefined()
    expect(newestVersionDir([])).toBeUndefined()
  })
  it("不带 v 前缀的目录名（fnm 之类）也认", () => {
    expect(newestVersionDir(["18.0.0", "20.5.1"])).toBe("20.5.1")
  })
})

describe("fallbackDirCandidates", () => {
  it("Homebrew 两种芯片的目录、nodejs.org 安装包的 /usr/local/bin 都在", () => {
    const dirs = fallbackDirCandidates("/Users/x")
    expect(dirs).toContain("/opt/homebrew/bin")
    expect(dirs).toContain("/usr/local/bin")
  })
  it("用户目录下的版本管理器：volta / asdf / mise，nvm 只有传了版本才有", () => {
    const without = fallbackDirCandidates("/Users/x")
    expect(without).toContain("/Users/x/.volta/bin")
    expect(without).toContain("/Users/x/.asdf/shims")
    expect(without).toContain("/Users/x/.local/share/mise/shims")
    expect(without.some((d) => d.includes(".nvm"))).toBe(false)
    expect(fallbackDirCandidates("/Users/x", "v22.23.2")).toContain("/Users/x/.nvm/versions/node/v22.23.2/bin")
  })
  it("没有家目录时不拼出 /.volta 这类错路径", () => {
    const dirs = fallbackDirCandidates("")
    expect(dirs.every((d) => d.startsWith("/opt/") || d.startsWith("/usr/"))).toBe(true)
  })
})

describe("supportsLoginShellProbe", () => {
  it("zsh / bash / fish / ksh / sh 可以；csh / tcsh / nu 参数不同，不用", () => {
    for (const s of ["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish", "/bin/ksh", "/bin/sh"]) expect(supportsLoginShellProbe(s), s).toBe(true)
    for (const s of ["/bin/csh", "/bin/tcsh", "/usr/local/bin/nu", ""]) expect(supportsLoginShellProbe(s), s).toBe(false)
  })
})
