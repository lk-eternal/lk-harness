import { isNewerVersion, type MobileUpdateInfo } from "../shared/app-update"

const DISMISSED_KEY = "lk-mobile-dismissed-update"

export interface PendingUpdate {
  version: string
  /** 下载地址，交给系统浏览器 */
  apkUrl: string
  /** 调不起系统浏览器时，给用户手动去打开的地址：电脑端内置的 APK 就是上面的下载地址，GitHub 来源是发布页 */
  releaseUrl: string
}

/**
 * 解析出 APK 的下载地址。
 * 电脑端内置了 APK 时给的是相对路径，接在「手机当前连着的电脑地址」后面——手机自己最清楚哪个地址是通的，
 * 比电脑端猜出来的绝对地址可靠（反向代理后面电脑端看不到外部地址）。没有相对路径就用绝对地址（旧版电脑端、GitHub 来源）。
 */
export function resolveApkUrl(info: MobileUpdateInfo, baseUrl: string): string | null {
  const base = baseUrl.trim().replace(/\/+$/, "")
  if (info.apkPath && info.apkPath.startsWith("/") && base) return `${base}${info.apkPath}`
  return info.apkUrl || null
}

/**
 * 根据电脑端给的最新版本，判断要不要给用户看「有新版本」。
 * 用户点过「忽略」的那个版本不再提示；更新的版本出来后会重新提示。
 * baseUrl 是手机当前连着的电脑地址，用来拼电脑端内置 APK 的下载地址。
 */
export function pendingUpdate(
  info: MobileUpdateInfo | null | undefined,
  currentVersion: string,
  dismissedVersion: string,
  baseUrl = "",
): PendingUpdate | null {
  if (!info?.ok || !info.latestVersion) return null
  const apkUrl = resolveApkUrl(info, baseUrl)
  if (!apkUrl) return null
  if (!isNewerVersion(info.latestVersion, currentVersion)) return null
  if (dismissedVersion && info.latestVersion === dismissedVersion) return null
  return {
    version: info.latestVersion,
    apkUrl,
    releaseUrl: info.source === "desktop" ? apkUrl : (info.releaseUrl ?? apkUrl),
  }
}

export function loadDismissedUpdate(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) ?? ""
  } catch {
    return ""
  }
}

export function saveDismissedUpdate(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version)
  } catch {
    // 存不了就下次再提示，不影响使用
  }
}
