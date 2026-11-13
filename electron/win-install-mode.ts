/**
 * 判断这份 Windows 安装是不是「仅当前用户」方式装的。
 *
 * 为什么要管这个：静默安装「所有用户」方式装的应用，安装器会弹 UAC 要管理员确认。
 * 用户在场时点一下就行；「空闲时自动重启安装」是用户不在场时发生的，应用先关掉、安装器再等一个没人点的 UAC，
 * 结果是应用一直起不来（飞书、手机端全离线）。所以只在能确认是「仅当前用户」安装时才自动重启。
 *
 * 依据：electron-builder 的 NSIS 安装器把安装信息写在 `Software\<GUID>`，仅当前用户写 HKCU、所有用户写 HKLM；
 * GUID 是 appId 派生的 UUID v5（electron-builder 的固定命名空间），没有在配置里单独指定 guid 时就是它。
 * 判断「确认」的方向是保守的：reg.exe 跑不起来、查不到、HKLM 也有，都按「没确认」处理。
 */

import { execFile, type ExecFileException } from "node:child_process"
import { createHash } from "node:crypto"
import * as path from "node:path"

/** 和 electron-builder.yml 里的 appId 一致（tests/win-install-mode.test.ts 守着） */
export const APP_ID = "com.lk-harness.desktop"
/** electron-builder 的 NSIS 目标派生 GUID 用的命名空间（app-builder-lib 的 ELECTRON_BUILDER_NS_UUID） */
const ELECTRON_BUILDER_NS_UUID = "50e065bc-3134-11e6-9bab-38c9862bdaf3"

/** UUID v5（SHA-1）：和 electron-builder 的 UUID.v5(appId, NS) 一致 */
export function uuidV5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex")
  const hash = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf8")).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 安装器在注册表里用的 GUID */
export function nsisInstallGuid(appId: string = APP_ID): string {
  return uuidV5(appId, ELECTRON_BUILDER_NS_UUID)
}

export interface RegQueryResult {
  /** reg.exe 的退出码；没能启动（找不到程序、超时）为 null */
  code: number | null
}

export type RegQuery = (key: string, value: string) => Promise<RegQueryResult>

/** 真正去跑 reg.exe。只看退出码（0 = 有这个值，1 = 没有）：它的提示文字跟着系统语言走，不能解析 */
export const queryRegistry: RegQuery = (key, value) =>
  new Promise((resolve) => {
    const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows"
    const exe = path.win32.join(systemRoot, "System32", "reg.exe")
    execFile(exe, ["query", key, "/v", value], { windowsHide: true, timeout: 8_000 }, (err: ExecFileException | null) => {
      if (!err) return resolve({ code: 0 })
      // 非零退出码时 code 是数字；启动失败（ENOENT）、超时被杀（code 为字符串或 null）都算没能查
      resolve({ code: typeof err.code === "number" ? err.code : null })
    })
  })

/**
 * 是不是确认的「仅当前用户」安装：HKCU 里有安装位置，并且 HKLM 里没有。
 * 只有 HKCU 查到（退出码 0）且 HKLM 明确查不到（退出码 1）才算确认。
 */
export async function detectPerUserInstall(opts: { platform?: string; appId?: string; query?: RegQuery } = {}): Promise<boolean> {
  if ((opts.platform ?? process.platform) !== "win32") return false
  const query = opts.query ?? queryRegistry
  const keyPath = `Software\\${nsisInstallGuid(opts.appId ?? APP_ID)}`
  try {
    const [user, machine] = await Promise.all([
      query(`HKCU\\${keyPath}`, "InstallLocation"),
      query(`HKLM\\${keyPath}`, "InstallLocation"),
    ])
    return user.code === 0 && machine.code === 1
  } catch {
    return false
  }
}
