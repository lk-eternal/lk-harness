// ── 图形应用拿不到终端 PATH 的补救（macOS / Linux）──
// 从 Finder / Dock / 桌面图标启动的应用，PATH 是系统给的最小集合（macOS 上只有 /usr/bin:/bin:/usr/sbin:/sbin），
// 不含 /opt/homebrew/bin、/usr/local/bin，更不含 nvm / fnm / volta 在 .zshrc 里加的目录。
// 结果是终端里 `node -v` 好好的，应用里却「未检测到 Node.js」。
// 这里只放纯逻辑（拆合并 PATH、解析 login shell 的输出、兜底目录候选），真正的进程和文件系统操作在 electron/shell-path.ts。

/** 夹在 login shell 输出两头的标记：rc 文件可能自己往标准输出打东西，要靠它把 env 的输出单独切出来 */
export const SHELL_ENV_DELIMITER = "__LK_HARNESS_SHELL_ENV__"

/** 拆成目录列表：去掉空段、去掉末尾斜杠（根目录除外） */
export function splitPathList(value: string | undefined, sep = ":"): string[] {
  const out: string[] = []
  for (const raw of (value ?? "").split(sep)) {
    if (!raw) continue
    out.push(raw.length > 1 ? raw.replace(/\/+$/, "") || "/" : raw)
  }
  return out
}

export interface PathParts {
  /** login shell 里的 PATH：和用户在终端里看到的一致，排最前 */
  shell?: string
  /** 应用现在的 PATH：系统给的那几个目录接在后面 */
  current?: string
  /** 兜底目录：拿不到 login shell 时，也能找到常见安装方式装的 node / CLI */
  fallback?: string[]
}

/** 合并三段 PATH，按「shell → 当前 → 兜底」排序，重复的目录只留第一次出现的位置 */
export function buildPath(parts: PathParts, sep = ":"): string {
  const seen = new Set<string>()
  const merged: string[] = []
  const lists = [splitPathList(parts.shell, sep), splitPathList(parts.current, sep), (parts.fallback ?? []).flatMap((d) => splitPathList(d, sep))]
  for (const list of lists) {
    for (const dir of list) {
      if (seen.has(dir)) continue
      seen.add(dir)
      merged.push(dir)
    }
  }
  return merged.join(sep)
}

/** 从 `<标记>env 的输出<标记>` 里取出 PATH；没有标记（shell 没跑完）或没有 PATH 行时返回 undefined */
export function parseShellEnvPath(stdout: string, delimiter = SHELL_ENV_DELIMITER): string | undefined {
  const start = stdout.indexOf(delimiter)
  if (start < 0) return undefined
  const end = stdout.indexOf(delimiter, start + delimiter.length)
  if (end < 0) return undefined
  for (const line of stdout.slice(start + delimiter.length, end).split(/\r?\n/)) {
    if (line.startsWith("PATH=")) return line.slice("PATH=".length) || undefined
  }
  return undefined
}

/** 版本目录名里（v22.23.2）最新的一个；没有一个像版本号的返回 undefined */
export function newestVersionDir(names: string[]): string | undefined {
  let best: { name: string; v: [number, number, number] } | undefined
  for (const name of names) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(name)
    if (!m) continue
    const v: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && (v[1] > best.v[1] || (v[1] === best.v[1] && v[2] > best.v[2])))) best = { name, v }
  }
  return best?.name
}

/**
 * 兜底目录候选（调用方只保留真实存在的）：Homebrew（Apple 芯片 / Intel）、nodejs.org 安装包装到的 /usr/local/bin、
 * volta / asdf / mise 的 shim、nvm 里最新的一个版本、npm 全局目录改到用户目录后的位置。
 * nvm 只能猜「最新的版本」，不一定是用户的默认版本，所以只作兜底：login shell 读到了就以它为准。
 */
export function fallbackDirCandidates(home: string, nvmNewest?: string): string[] {
  const dirs = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]
  if (home) {
    dirs.push(`${home}/.volta/bin`, `${home}/.asdf/shims`, `${home}/.local/share/mise/shims`)
    if (nvmNewest) dirs.push(`${home}/.nvm/versions/node/${nvmNewest}/bin`)
    dirs.push(`${home}/.npm-global/bin`, `${home}/.local/bin`)
  }
  return dirs
}

/** 能用 `-ilc` 取环境的 shell；csh / tcsh / nu 之类参数不同，不碰，只靠兜底目录 */
export function supportsLoginShellProbe(shellPath: string): boolean {
  const base = shellPath.split("/").pop() ?? ""
  return ["zsh", "bash", "fish", "ksh", "sh"].includes(base)
}
