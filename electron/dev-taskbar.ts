/**
 * 开发模式（npm run dev）下的任务栏身份。
 *
 * Windows 任务栏按 AppUserModelID 给窗口分组，并拿这个 ID 去匹配开始菜单里的快捷方式、用快捷方式的图标。
 * 开发时进程是 electron.exe，ID 就是 Electron 的默认值 `electron.app.Electron`；只要开始菜单里有
 * 一个登记了这个 ID 的 `Electron.lnk`（跑过任何 Electron 项目都可能留下），任务栏就用它指向的
 * electron.exe 的图标，窗口自己的 `icon` 参数被忽略，于是显示成 Electron 的原子图标。
 *
 * 做法：给窗口单独设一个开发专用的 ID，并带上图标路径。只改窗口，不改进程级的 ID，
 * 所以 Windows 通知的归属（见 app-chat-notify.ts）和安装版都不受影响。
 * 打包版有安装包的快捷方式和 exe 图标，不需要这个；ID 也刻意和安装版（com.lk-harness.desktop）不同，
 * 免得开发窗口被并进安装版的任务栏按钮。
 */

/** 开发专用 ID 的前缀。和 electron-builder.yml 的 appId 不同，不要改成一样的 */
export const DEV_APP_USER_MODEL_ID = "com.lk-harness.desktop.dev"

export interface DevTaskbarInput {
  platform: string
  isPackaged: boolean
  /** electron.exe */
  execPath: string
  /** 应用目录（开发时是项目根） */
  appPath: string
  /** .ico 的绝对路径 */
  iconPath: string
  /** --profile=xxx 的 xxx；没有就空 */
  profileName?: string
}

/** 命令行参数里有空格或引号才加引号 */
function quoteArg(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
}

/**
 * 开发模式下要给主窗口设的任务栏信息；不需要设（非 Windows、已打包）返回 null。
 * 不同 profile 用不同 ID：同时开几个开发实例时各占一个任务栏按钮。
 * `npm run dev` 默认的 profile 就叫 dev，它和不带 profile 的都用基础 ID，不重复拼一个 `.dev`。
 */
export function devTaskbarDetails(input: DevTaskbarInput): Electron.AppDetailsOptions | null {
  if (input.platform !== "win32" || input.isPackaged) return null
  const profile = (input.profileName ?? "").trim()
  // AppUserModelID 不能有空格、最长 128 个字符，profile 只留安全字符
  const safeProfile = profile.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)
  const args = [input.execPath, input.appPath, ...(profile ? [`--profile=${profile}`] : [])]
  return {
    appId: safeProfile && safeProfile !== "dev" ? `${DEV_APP_USER_MODEL_ID}.${safeProfile}` : DEV_APP_USER_MODEL_ID,
    appIconPath: input.iconPath,
    appIconIndex: 0,
    // relaunchCommand 和 relaunchDisplayName 必须成对设（Electron 文档要求）；探针是在三项齐全时验证的。
    // 命令只在用户把开发窗口固定到任务栏再点它时用到
    relaunchCommand: args.map(quoteArg).join(" "),
    // 和窗口标题（main.ts）同一个写法
    relaunchDisplayName: profile ? `LK Harness [${profile}]` : "LK Harness (dev)",
  }
}
