/**
 * 「空闲时自动重启安装」要看的现场情况：电脑空闲了多久、Agent 在不在忙、有没有排队的消息、是不是仅当前用户安装。
 * 决策在 src/shared/silent-update.ts，重启动作在 electron/updater.ts；这里只负责把这些情况取出来。
 * 在应用就绪（app ready）之后调用 createIdleRestartProbes，powerMonitor 要等就绪后才能用。
 */

import { app, powerMonitor } from "electron"
import { agentQuietMs } from "./agent-activity"
import { getSdkSessionCount } from "./agent-sdk"
import { getDaemonStatus } from "./daemon-manager"
import { listLlmWorkerPhases } from "./llm-session-worker"
import { hasLaunchesInFlight } from "./session-dispatcher"
import { listSdkWorkerPhases } from "./sdk-session-worker"
import { clearRestartMarker, writeRestartMarker } from "./update-restart-marker"
import { detectPerUserInstall } from "./win-install-mode"
import type { IdleRestartProbes } from "./updater"

/**
 * 此刻有没有 Agent 在跑回合或正在拉起。
 * 只认「回合进行中」：回复完 Agent 仍挂在 poll 上监听，在线的会话大多没在干活，退出时也不会丢东西（session-branch 也是这么判断的）。
 * 监听以外的阶段（处理中、正在停止）都按在忙算。
 */
export function agentWorkInFlight(): boolean {
  if (hasLaunchesInFlight()) return true
  if (getSdkSessionCount() > 0) return true
  if (listSdkWorkerPhases().some((p) => p !== "listening")) return true
  for (const phase of listLlmWorkerPhases().values()) {
    if (phase !== "listening") return true
  }
  return false
}

/** daemon 队列里排队和处理中的消息数。daemon 没在跑：没有通道在收消息，算 0；正在启动或没给出数字：拿不到 */
export async function queuedMessages(): Promise<number | null> {
  const status = await getDaemonStatus()
  if (!status.running) return status.starting ? null : 0
  if (status.queueCounts) return status.queueCounts.pending + status.queueCounts.processing
  if (typeof status.queueLength === "number") return status.queueLength
  return null
}

export function createIdleRestartProbes(): IdleRestartProbes {
  // 睡眠唤醒、解锁屏幕都算用户刚来过：系统的「空闲时间」在唤醒那一刻还是睡前最后一次操作算起，不能直接信
  let lastReturnAt = Date.now()
  const noteReturn = (): void => {
    lastReturnAt = Date.now()
  }
  powerMonitor.on("resume", noteReturn)
  powerMonitor.on("unlock-screen", noteReturn)

  let perUser: Promise<boolean> | null = null

  return {
    userIdleSeconds() {
      const idle = powerMonitor.getSystemIdleTime()
      if (!Number.isFinite(idle) || idle < 0) return null
      return Math.min(idle, (Date.now() - lastReturnAt) / 1000)
    },
    agentWorkInFlight,
    agentQuietMs: () => agentQuietMs(),
    queuedMessages,
    // 这份安装在进程存活期间不会变：只查一次
    perUserInstall: () => (perUser ??= detectPerUserInstall()),
    beforeRestart: ({ keepHidden }) => writeRestartMarker(app.getPath("userData"), keepHidden),
    cancelRestart: () => clearRestartMarker(app.getPath("userData")),
  }
}
