import { describe, expect, it } from "vitest"
import { macInstallerUrl, summarizeBrewFailure } from "../electron/brew-update"

/** 用户反馈的真实输出（用户名换成了 someone）：Warning 在前，目录权限的 Error 夹在中间，后面跟 Tier 3 说明 */
const NOT_WRITABLE = `Command failed: /usr/local/bin/brew install --cask lk-harness
Warning: You are using macOS on Intel x86_64.
We do not provide support for this platform (as-of September 2026, announced August 2025).

Homebrew no longer builds bottles for this configuration.
Existing bottles may still work, but updated formulae may build from source.

Warning: The following taps are not trusted:
  adoptopenjdk/openjdk
  dart-lang/dart

Homebrew is currently ignoring formulae, casks and commands
from these taps because tap trust is required.
Untap them with:
  brew untap adoptopenjdk/openjdk dart-lang/dart
For more information, see:
  https://docs.brew.sh/Tap-Trust

Error: The following directories are not writable by your user:
  /usr/local/lib
  /usr/local/lib/pkgconfig

You should change the ownership of these directories to your user,
and make sure that you have write permission.
  sudo chown -R someone /usr/local/lib /usr/local/lib/pkgconfig
  chmod u+w /usr/local/lib /usr/local/lib/pkgconfig

This is a Tier 3 configuration:
  https://docs.brew.sh/Support-Tiers#tier-3
You can report issues with Tier 3 configurations to Homebrew/* repositories!

Read the above document before opening any issues or PRs.
`

describe("summarizeBrewFailure", () => {
  it("只留 Error 块：Warning 和 Tier 3 说明都不在里面", () => {
    const out = summarizeBrewFailure(NOT_WRITABLE)
    expect(out.startsWith("Error: The following directories are not writable by your user:")).toBe(true)
    expect(out).not.toContain("Warning:")
    expect(out).not.toContain("adoptopenjdk")
    expect(out).not.toContain("Tier 3")
    expect(out).not.toContain("Command failed")
  })

  it("brew 自己给的修复命令保留下来", () => {
    const out = summarizeBrewFailure(NOT_WRITABLE)
    expect(out).toContain("sudo chown -R someone /usr/local/lib /usr/local/lib/pkgconfig")
    expect(out).toContain("chmod u+w /usr/local/lib /usr/local/lib/pkgconfig")
  })

  it("Windows 换行也能处理", () => {
    const out = summarizeBrewFailure(NOT_WRITABLE.replace(/\n/g, "\r\n"))
    expect(out).toContain("sudo chown -R someone")
    expect(out).not.toContain("\r")
    expect(out).not.toContain("Tier 3")
  })

  it("没有 Tier 3 说明时，Error 之后的内容都保留", () => {
    const out = summarizeBrewFailure("Warning: noise\n\nError: Cask 'x' is unavailable\nTry again later")
    expect(out).toBe("Error: Cask 'x' is unavailable\nTry again later")
  })

  it("Error 块过长时截断并标出", () => {
    const long = ["Error: boom", ...Array.from({ length: 80 }, (_, i) => `  line ${i}`)].join("\n")
    const lines = summarizeBrewFailure(long).split("\n")
    expect(lines[0]).toBe("Error: boom")
    expect(lines.length).toBeLessThanOrEqual(31)
    expect(lines[lines.length - 1]).toBe("…")
  })

  it("没有 Error 行（超时、被中断）时去掉 Warning 段落，保留其余", () => {
    const out = summarizeBrewFailure("Warning: noise line 1\nnoise line 2\n\nCommand failed: brew update\nkilled by timeout")
    expect(out).toBe("Command failed: brew update\nkilled by timeout")
  })

  it("没有 Error 行时只留最后一部分", () => {
    const out = summarizeBrewFailure(Array.from({ length: 40 }, (_, i) => `step ${i}`).join("\n"))
    const lines = out.split("\n")
    expect(lines[0]).toBe("…")
    expect(lines[lines.length - 1]).toBe("step 39")
    expect(lines).toHaveLength(13)
  })

  it("全是 Warning 时不返回空串", () => {
    const out = summarizeBrewFailure("Warning: only noise here")
    expect(out).toBe("Warning: only noise here")
  })
})

describe("macInstallerUrl", () => {
  const base = "https://github.com/lk-eternal/lk-harness/releases"

  it("Apple 芯片取 arm64 的 dmg，Intel 取不带后缀的", () => {
    expect(macInstallerUrl(base, "1.2.0", "arm64")).toBe(`${base}/download/v1.2.0/LK.Harness-1.2.0-arm64.dmg`)
    expect(macInstallerUrl(base, "1.2.0", "x64")).toBe(`${base}/download/v1.2.0/LK.Harness-1.2.0.dmg`)
  })

  it("文件名里的空格是 GitHub 换成的 `.`，不能用 %20（那个地址是 404）", () => {
    for (const arch of ["arm64", "x64"]) {
      const url = macInstallerUrl(base, "1.2.0", arch)
      expect(url).not.toContain("%20")
      expect(url).not.toContain(" ")
    }
  })
})
