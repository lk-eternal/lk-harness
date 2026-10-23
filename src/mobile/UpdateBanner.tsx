import type { PendingUpdate } from "./update-check"

/** 新版本提示条（仅 App 内出现）：一行，点「下载更新」交给系统浏览器，点「忽略」则该版本不再提示 */
export default function UpdateBanner({
  update,
  currentVersion,
  onUpdate,
  onDismiss,
}: {
  update: PendingUpdate
  currentVersion: string
  onUpdate: () => void
  onDismiss: () => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line-subtle bg-raised px-4 py-1.5 text-xs text-fg-2">
      <span className="min-w-0 flex-1 truncate">
        发现新版本 v{update.version}（当前 v{currentVersion}）
      </span>
      <button
        type="button"
        onClick={onUpdate}
        className="shrink-0 rounded-lg bg-blue-600 px-2.5 py-1 font-medium text-white active:opacity-80"
      >
        下载更新
      </button>
      <button type="button" onClick={onDismiss} className="shrink-0 px-1.5 py-1 text-fg-muted active:opacity-70">
        忽略
      </button>
    </div>
  )
}
