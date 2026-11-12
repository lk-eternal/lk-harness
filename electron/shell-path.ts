// ── 把终端里的 PATH 补进应用进程（macOS / Linux）──
// 背景见 src/shared/shell-path.ts：图形应用的 PATH 是系统给的最小集合，终端里能用的 node / lark-cli / meegle 这里找不到。
// 做法分两步，都是改 process.env.PATH（之后起的子进程——工具箱检测、daemon、MCP——都继承它）：
//   1. 立刻（同步）：把 Homebrew、/usr/local/bin、volta / asdf / mise / nvm 等常见目录里真实存在的补上。
//      装在这些位置的用户不用等任何东西。
//   2. 后台：开一个 login shell（`$SHELL -ilc env`）读用户在 .zprofile / .zshrc / .bash_profile 里配出来的 PATH，
//      排到最前面，和终端里看到的顺序一致。nvm / fnm 这类只在 rc 文件里初始化的靠这一步。
// 需要完整 PATH 的地方（工具箱检测、启动 daemon）await shellPathReady()。Windows 不需要，直接跳过。
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import { promisify } from "node:util"
import { SHELL_ENV_DELIMITER, buildPath, fallbackDirCandidates, newestVersionDir, parseShellEnvPath, splitPathList, supportsLoginShellProbe } from "../src/shared/shell-path"

const execFileAsync = promisify(execFile)

/** rc 文件很重（或者卡在交互提示上）时别拖住启动：超时就放弃 login shell，只用兜底目录 */
const SHELL_PROBE_TIMEOUT_MS = 6_000

export interface ShellPathDeps {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  /** 用户的登录 shell（如 /bin/zsh）；取不到就是 undefined */
  shell?: string
  exists(p: string): boolean
  /** 列出目录里的子项名；读不了返回空数组 */
  listDir(p: string): string[]
  /** 开 login shell 取它的 PATH；失败（超时、报错、没读到）返回 undefined */
  probeShellPath(shell: string): Promise<string | undefined>
}

export interface ShellPathResult {
  /** 是否执行了补全（Windows 不需要，跳过） */
  applied: boolean
  /** 是否读到了 login shell 的 PATH */
  shellOk: boolean
  /** 这次新加进 PATH 的目录 */
  added: string[]
}

/** 取 login shell 的环境：命令前后各打一个标记，rc 文件自己往标准输出打的东西不会混进来 */
export async function probeLoginShellPath(shell: string, timeoutMs = SHELL_PROBE_TIMEOUT_MS): Promise<string | undefined> {
  const mark = `printf '%s' '${SHELL_ENV_DELIMITER}'`
  let stdout = ""
  try {
    const p = execFileAsync(shell, ["-ilc", `${mark}; env; ${mark}`], {
      timeout: timeoutMs,
      // 交互式 shell 会忽略 SIGTERM，超时只能强杀
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        // oh-my-zsh 的自动更新会停在「要不要更新」的提示上；tmux 插件会把 shell 换成 tmux 会话
        DISABLE_AUTO_UPDATE: "true",
        ZSH_TMUX_AUTOSTARTED: "true",
        ZSH_TMUX_AUTOSTART: "false",
      },
    })
    p.child.stdin?.end()
    stdout = (await p).stdout
  } catch (e) {
    // 退出码非 0（rc 文件末尾的命令失败等）时输出可能已经完整，照样试着解析
    stdout = typeof (e as { stdout?: unknown })?.stdout === "string" ? (e as { stdout: string }).stdout : ""
  }
  return parseShellEnvPath(stdout)
}

export function defaultShellPathDeps(): ShellPathDeps {
  let shell = process.env.SHELL
  if (!shell) {
    try { shell = os.userInfo().shell ?? undefined } catch { /* 没有 passwd 记录 */ }
  }
  return {
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    shell: shell || (process.platform === "darwin" ? "/bin/zsh" : undefined),
    exists: (p) => { try { return fs.existsSync(p) } catch { return false } },
    listDir: (p) => { try { return fs.readdirSync(p) } catch { return [] } },
    probeShellPath: (s) => probeLoginShellPath(s),
  }
}

function writePath(env: NodeJS.ProcessEnv, next: string): string[] {
  const before = new Set(splitPathList(env.PATH))
  env.PATH = next
  return splitPathList(next).filter((d) => !before.has(d))
}

/** 补全 env.PATH；返回新加了哪些目录。同步部分（兜底目录）先落地，再等 login shell */
export async function applyShellPath(deps: ShellPathDeps = defaultShellPathDeps()): Promise<ShellPathResult> {
  if (deps.platform === "win32") return { applied: false, shellOk: false, added: [] }

  const nvmDir = `${deps.home}/.nvm/versions/node`
  const nvmNewest = deps.home ? newestVersionDir(deps.listDir(nvmDir)) : undefined
  const fallback = fallbackDirCandidates(deps.home, nvmNewest).filter((d) => deps.exists(d))
  const added = writePath(deps.env, buildPath({ current: deps.env.PATH, fallback }))

  let shellPath: string | undefined
  if (deps.shell && supportsLoginShellProbe(deps.shell) && deps.exists(deps.shell)) {
    shellPath = await deps.probeShellPath(deps.shell).catch(() => undefined)
  }
  if (shellPath) {
    // login shell 的目录排最前，其余保持原有顺序
    for (const d of writePath(deps.env, buildPath({ shell: shellPath, current: deps.env.PATH }))) added.push(d)
  }
  return { applied: true, shellOk: !!shellPath, added: [...new Set(added)] }
}

let ready: Promise<void> = Promise.resolve()
let started = false

/**
 * 应用启动时调一次：同步目录马上生效，login shell 的结果在后台补上（shellPathReady 在它结束后 resolve，不会 reject）。
 * `log` 把结果写进应用日志，用户反馈「检测不到 node」时能看到补了哪些目录、login shell 有没有读成功。
 */
export function initShellPath(log?: (message: string) => void): Promise<void> {
  if (started) return ready
  started = true
  ready = applyShellPath()
    .then((r) => {
      if (!r.applied) return
      log?.(`[Env] 已补全 PATH：${r.shellOk ? "读到了 login shell 的 PATH" : "没读到 login shell 的 PATH（只用了常见安装目录）"}；新增 ${r.added.length} 个目录${r.added.length ? `：${r.added.join(" ")}` : ""}`)
    })
    .catch((e) => { log?.(`[Env] 补全 PATH 失败：${e instanceof Error ? e.message : String(e)}`) })
  return ready
}

/** 需要完整 PATH 才能找到 node / lark-cli / meegle 的地方先等它（没调过 initShellPath 就是立刻 resolve） */
export function shellPathReady(): Promise<void> {
  return ready
}
