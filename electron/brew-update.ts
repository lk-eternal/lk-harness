/**
 * macOS 更新走 Homebrew，它失败的原因五花八门（目录权限、tap 未信任、平台不受支持……）。
 * 这里只放不依赖 electron 的纯函数：把 brew 的输出整理成用户看得懂的原因，以及不用 brew 时的安装包下载地址。
 */

import * as path from "node:path"

const MAX_LINES = 30
const MAX_FALLBACK_LINES = 12

/** brew 在 Error 后面常附一段 Tier 3 配置的说明，叫人去给 Homebrew 提 issue，和 LK Harness 的用户无关 */
const TIER_NOTE = /^This is a Tier \d/

/**
 * 从 brew 的输出里挑出真正的失败原因。
 * brew 会先打一堆 Warning（平台不受支持、别的 tap 未信任……），真正的 `Error:` 夹在后面，
 * 整段原样放进弹窗，原因就被淹没了；它自己给出的修复命令（比如 `sudo chown …`）在 Error 块里，要保留。
 */
export function summarizeBrewFailure(output: string): string {
  const lines = output.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd())

  const start = lines.findIndex((l) => l.startsWith("Error:"))
  if (start >= 0) {
    const tail = lines.slice(start)
    const note = tail.findIndex((l) => TIER_NOTE.test(l))
    return clip(trimBlank(note > 0 ? tail.slice(0, note) : tail), MAX_LINES)
  }

  // 没有 Error 行（超时、被中断……）：去掉 Warning 段落，留最后一部分
  const kept = output
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .filter((p) => !p.trimStart().startsWith("Warning:"))
    .join("\n\n")
    .split("\n")
    .map((l) => l.trimEnd())
  const body = trimBlank(kept)
  if (body.length === 0) return output.trim()
  return body.length > MAX_FALLBACK_LINES ? `…\n${body.slice(-MAX_FALLBACK_LINES).join("\n")}` : body.join("\n")
}

function trimBlank(lines: string[]): string[] {
  let from = 0
  let to = lines.length
  while (from < to && lines[from].trim() === "") from++
  while (to > from && lines[to - 1].trim() === "") to--
  return lines.slice(from, to)
}

function clip(lines: string[], max: number): string {
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n…` : lines.join("\n")
}

/** `brew list --cask <名字>` 的结果：装了 / 没装 / 没问出来（超时、brew 自己坏了……） */
export type BrewListOutcome = "installed" | "not-installed" | "unknown"

/**
 * 把 `brew list --cask` 失败的错误归类。brew 对「这个 cask 没装」的约定是退出码 1；
 * 其余（超时被杀、找不到可执行文件、别的退出码）说明没问出结果，不能当成「没装」。
 */
export function classifyBrewListFailure(err: unknown): BrewListOutcome {
  const code = (err as { code?: unknown } | null)?.code
  return code === 1 ? "not-installed" : "unknown"
}

export type MacInstallMethod = "brew" | "dmg"

export interface MacInstallDetection {
  method: MacInstallMethod
  /** 判断依据，写日志用 */
  reason: string
}

export interface MacInstallProbes {
  /** brew 可执行文件的路径；没装 Homebrew 为 null */
  brewPath: string | null
  cask: string
  isDirectory(p: string): boolean
  listCask(brewPath: string): Promise<BrewListOutcome>
}

/**
 * 这份 LK Harness 是不是 brew 装的。brew 装的继续走 brew 升级；其余（dmg 拖进「应用程序」的）走应用内更新。
 *
 * 判断只信 brew 自己的登记：`<prefix>/Caskroom/<cask>` 目录存在、并且 `brew list --cask` 说装了。
 * 没问出结果时按 brew 算——宁可让 brew 自己报错，也不能把 brew 用户的应用悄悄原地换掉、和它的登记对不上。
 * 不能用「brew 装了没有」代替：很多 dmg 用户也装着 brew（这次要修的正是这种人）。
 */
export async function detectMacInstallMethod(probes: MacInstallProbes): Promise<MacInstallDetection> {
  const { brewPath, cask } = probes
  if (!brewPath) return { method: "dmg", reason: "本机没有 Homebrew" }
  // brew 的前缀就是 brew 可执行文件所在目录（bin）的上一层：/opt/homebrew 或 /usr/local
  const prefix = path.posix.dirname(path.posix.dirname(brewPath))
  const caskroom = path.posix.join(prefix, "Caskroom", cask)
  if (!probes.isDirectory(caskroom)) {
    return { method: "dmg", reason: `brew 没有登记 ${cask}（${caskroom} 不存在）` }
  }
  const listed = await probes.listCask(brewPath)
  if (listed === "installed") return { method: "brew", reason: `brew 登记了 ${cask}` }
  if (listed === "not-installed") {
    return { method: "dmg", reason: `${caskroom} 在，但 brew 说 ${cask} 没装（残留目录）` }
  }
  return { method: "brew", reason: `${caskroom} 在，brew list 没问出结果，按 brew 处理` }
}

/**
 * 不用 brew 时的安装包直链，按本机芯片选 Intel / Apple 芯片的 dmg。
 *
 * 地址里是 `LK.Harness-…` 而不是 `LK%20Harness-…`：GitHub 上传安装包时把文件名里的空格换成了 `.`，
 * 带 `%20` 的地址实测是 404。
 */
export function macInstallerUrl(releasesBase: string, version: string, arch: string): string {
  const suffix = arch === "arm64" ? "-arm64" : ""
  return `${releasesBase}/download/v${version}/LK.Harness-${version}${suffix}.dmg`
}
