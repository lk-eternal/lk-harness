/**
 * macOS 更新走 Homebrew，它失败的原因五花八门（目录权限、tap 未信任、平台不受支持……）。
 * 这里只放不依赖 electron 的纯函数：把 brew 的输出整理成用户看得懂的原因，以及不用 brew 时的安装包下载地址。
 */

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
