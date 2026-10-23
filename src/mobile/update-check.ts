import { isNewerVersion, type MobileUpdateInfo } from "../shared/app-update"

const DISMISSED_KEY = "lk-mobile-dismissed-update"

export interface PendingUpdate {
  version: string
  apkUrl: string
  releaseUrl: string
}

/**
 * 根据电脑端给的最新版本，判断要不要给用户看「有新版本」。
 * 用户点过「忽略」的那个版本不再提示；更新的版本出来后会重新提示。
 */
export function pendingUpdate(
  info: MobileUpdateInfo | null | undefined,
  currentVersion: string,
  dismissedVersion: string,
): PendingUpdate | null {
  if (!info?.ok || !info.latestVersion || !info.apkUrl) return null
  if (!isNewerVersion(info.latestVersion, currentVersion)) return null
  if (dismissedVersion && info.latestVersion === dismissedVersion) return null
  return {
    version: info.latestVersion,
    apkUrl: info.apkUrl,
    releaseUrl: info.releaseUrl ?? info.apkUrl,
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
