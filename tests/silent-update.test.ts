import { describe, expect, it } from "vitest"
import {
  IDLE_RESTART_AGENT_QUIET_MS,
  IDLE_RESTART_CHECK_INTERVAL_MS,
  IDLE_RESTART_MAX_ATTEMPTS,
  IDLE_RESTART_RETRY_AFTER_MS,
  IDLE_RESTART_USER_IDLE_SEC,
  RESTART_MARKER_TTL_MS,
  SILENT_CHECK_INTERVAL_MS,
  decideIdleRestart,
  decideSilentUpdate,
  idleRestartWaitText,
  isPermanentIdleWait,
  shouldStartHiddenAfterRestart,
  silentReadyMessage,
  type IdleRestartInput,
  type IdleRestartWaitReason,
  type SilentUpdateInput,
} from "../src/shared/silent-update.js"

const base: SilentUpdateInput = { enabled: true, busy: false, current: "1.4.1", remote: "1.4.2", readyVersion: null }
const decide = (extra: Partial<SilentUpdateInput> = {}) => decideSilentUpdate({ ...base, ...extra })

describe("decideSilentUpdate（什么时候在后台下载）", () => {
  it("开着、没在忙、远端更新：下载，带上要下的版本", () => {
    expect(decide()).toEqual({ action: "download", version: "1.4.2" })
  })

  it("没开：不动（其余条件再满足也不下）", () => {
    expect(decide({ enabled: false })).toEqual({ action: "skip", reason: "disabled" })
  })

  it("已经有一轮在查或在下：不再起第二路", () => {
    expect(decide({ busy: true })).toEqual({ action: "skip", reason: "busy" })
  })

  it("远端查不到：这一轮跳过，等下个周期", () => {
    expect(decide({ remote: null })).toEqual({ action: "skip", reason: "no-remote" })
    expect(decide({ remote: "" })).toEqual({ action: "skip", reason: "no-remote" })
  })

  it("远端和当前一样、或比当前还旧（版本源缓存滞后）：没有更新", () => {
    expect(decide({ remote: "1.4.1" })).toEqual({ action: "skip", reason: "up-to-date" })
    expect(decide({ remote: "1.4.0" })).toEqual({ action: "skip", reason: "up-to-date" })
  })

  it("远端版本号解析不了：当没有更新，宁可漏下也不误装", () => {
    expect(decide({ remote: "not-a-version" })).toEqual({ action: "skip", reason: "up-to-date" })
    expect(decide({ current: "dev" })).toEqual({ action: "skip", reason: "up-to-date" })
  })

  it("这一版已经下好了：不重复下", () => {
    expect(decide({ readyVersion: "1.4.2" })).toEqual({ action: "skip", reason: "already-downloaded" })
  })

  it("下好的是更旧的一版、远端又出了新的：重新下，以最新的为准", () => {
    expect(decide({ remote: "1.4.3", readyVersion: "1.4.2" })).toEqual({ action: "download", version: "1.4.3" })
  })

  it("跨次版本和预发布：1.5.0 比 1.4.9 新；正式版比同号预发布新", () => {
    expect(decide({ current: "1.4.9", remote: "1.5.0" })).toEqual({ action: "download", version: "1.5.0" })
    expect(decide({ current: "1.5.0-beta.1", remote: "1.5.0" })).toEqual({ action: "download", version: "1.5.0" })
  })

  it("判断顺序：没开优先于忙，忙优先于查不到", () => {
    expect(decide({ enabled: false, busy: true, remote: null })).toEqual({ action: "skip", reason: "disabled" })
    expect(decide({ busy: true, remote: null })).toEqual({ action: "skip", reason: "busy" })
  })
})

describe("静默更新的常量和文案", () => {
  it("定时复查间隔：几个小时一次，既不是每分钟打 GitHub，也不会一天才查一次", () => {
    expect(SILENT_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000)
    expect(SILENT_CHECK_INTERVAL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })

  it("下载好的提示：写明版本、退出时自动安装、不出现向导、可以立即安装", () => {
    const m = silentReadyMessage("1.4.2")
    expect(m).toContain("v1.4.2")
    expect(m).toContain("退出应用时会自动安装")
    expect(m).toContain("不会出现安装向导")
    expect(m).toContain("立即安装")
    // 没开空闲重启时不提它：别让用户以为电脑空闲时会自己重启
    expect(m).not.toContain("空闲")
  })

  it("开着空闲自动重启时，提示里多交代一句电脑空闲时会自动重启并安装", () => {
    const m = silentReadyMessage("1.4.2", true)
    expect(m).toContain("退出应用时会自动安装")
    expect(m).toContain("电脑空闲时也会自动重启并安装")
    expect(silentReadyMessage("1.4.2", false)).toBe(silentReadyMessage("1.4.2"))
  })
})

const idleBase: IdleRestartInput = {
  enabled: true,
  readyVersion: "1.4.2",
  current: "1.4.1",
  downloading: false,
  attempts: 0,
  perUserInstall: true,
  userIdleSec: IDLE_RESTART_USER_IDLE_SEC,
  agentBusy: false,
  agentQuietMs: IDLE_RESTART_AGENT_QUIET_MS,
  queued: 0,
}
const idle = (extra: Partial<IdleRestartInput> = {}) => decideIdleRestart({ ...idleBase, ...extra })
const wait = (reason: IdleRestartWaitReason) => ({ action: "wait", reason })

describe("decideIdleRestart（什么时候趁空闲自动重启安装）", () => {
  it("所有条件都满足：安装，带上要装的版本", () => {
    expect(idle()).toEqual({ action: "install", version: "1.4.2" })
  })

  it("没开：不动", () => {
    expect(idle({ enabled: false })).toEqual(wait("disabled"))
  })

  it("没有下好的版本、或下好的不比当前新（装过了、版本源回退）：没有可装的", () => {
    expect(idle({ readyVersion: null })).toEqual(wait("nothing-ready"))
    expect(idle({ readyVersion: "1.4.1" })).toEqual(wait("nothing-ready"))
    expect(idle({ readyVersion: "1.4.0" })).toEqual(wait("nothing-ready"))
    expect(idle({ readyVersion: "not-a-version" })).toEqual(wait("nothing-ready"))
  })

  it("又有一路下载在进行：等它下完，别急着装旧的一版", () => {
    expect(idle({ downloading: true })).toEqual(wait("downloading"))
  })

  it("同一个版本已经自动重启到上限：不再自动重启（装不上时别每隔几分钟关一次应用）", () => {
    expect(idle({ attempts: IDLE_RESTART_MAX_ATTEMPTS - 1 })).toEqual({ action: "install", version: "1.4.2" })
    expect(idle({ attempts: IDLE_RESTART_MAX_ATTEMPTS })).toEqual(wait("gave-up"))
    expect(idle({ attempts: IDLE_RESTART_MAX_ATTEMPTS + 5 })).toEqual(wait("gave-up"))
  })

  it("不是确认的「仅当前用户」安装：不自动重启（所有用户安装会弹 UAC，没人在场应用就起不来）", () => {
    expect(idle({ perUserInstall: false })).toEqual(wait("unsupported-install"))
  })

  it("有 Agent 在跑回合：不重启，哪怕电脑已经空闲很久", () => {
    expect(idle({ agentBusy: true, userIdleSec: 8 * 3600 })).toEqual(wait("agent-busy"))
  })

  it("Agent 刚刚还在工作（回合之间的空档）：不重启，刚好满安静时长才行", () => {
    expect(idle({ agentQuietMs: IDLE_RESTART_AGENT_QUIET_MS - 1 })).toEqual(wait("recent-agent-activity"))
    expect(idle({ agentQuietMs: 0 })).toEqual(wait("recent-agent-activity"))
    expect(idle({ agentQuietMs: IDLE_RESTART_AGENT_QUIET_MS })).toEqual({ action: "install", version: "1.4.2" })
  })

  it("队列里还有排队或处理中的消息：不重启；队列数取不到：当作不确定，也不重启", () => {
    expect(idle({ queued: 1 })).toEqual(wait("queue-busy"))
    expect(idle({ queued: 37 })).toEqual(wait("queue-busy"))
    expect(idle({ queued: null })).toEqual(wait("unknown-state"))
  })

  it("电脑最近有人操作：不重启，刚好满空闲时长才行", () => {
    expect(idle({ userIdleSec: IDLE_RESTART_USER_IDLE_SEC - 1 })).toEqual(wait("user-active"))
    expect(idle({ userIdleSec: 0 })).toEqual(wait("user-active"))
    expect(idle({ userIdleSec: IDLE_RESTART_USER_IDLE_SEC })).toEqual({ action: "install", version: "1.4.2" })
  })

  it("取不到电脑空闲时间：当作不确定，不重启（宁可晚装，也不在不确定时关应用）", () => {
    expect(idle({ userIdleSec: null })).toEqual(wait("unknown-state"))
  })

  it("判断顺序：没开 > 没有可装的 > 下载中 > 放弃 > 安装方式 > Agent > 队列 > 人", () => {
    const worst: Partial<IdleRestartInput> = {
      downloading: true,
      attempts: 9,
      perUserInstall: false,
      agentBusy: true,
      agentQuietMs: 0,
      queued: 5,
      userIdleSec: 0,
    }
    expect(idle({ ...worst, enabled: false, readyVersion: null })).toEqual(wait("disabled"))
    expect(idle({ ...worst, readyVersion: null })).toEqual(wait("nothing-ready"))
    expect(idle(worst)).toEqual(wait("downloading"))
    expect(idle({ ...worst, downloading: false })).toEqual(wait("gave-up"))
    expect(idle({ ...worst, downloading: false, attempts: 0 })).toEqual(wait("unsupported-install"))
    expect(idle({ ...worst, downloading: false, attempts: 0, perUserInstall: true })).toEqual(wait("agent-busy"))
    expect(idle({ ...worst, downloading: false, attempts: 0, perUserInstall: true, agentBusy: false })).toEqual(wait("recent-agent-activity"))
    expect(idle({ ...worst, downloading: false, attempts: 0, perUserInstall: true, agentBusy: false, agentQuietMs: 1e9 })).toEqual(wait("queue-busy"))
    expect(idle({ ...worst, downloading: false, attempts: 0, perUserInstall: true, agentBusy: false, agentQuietMs: 1e9, queued: 0 })).toEqual(wait("user-active"))
  })

  it("只有「确定不会再自动重启」的原因才算永久：其余每分钟都可能变", () => {
    const reasons: IdleRestartWaitReason[] = [
      "disabled", "nothing-ready", "downloading", "gave-up", "unsupported-install",
      "agent-busy", "recent-agent-activity", "queue-busy", "user-active", "unknown-state",
    ]
    expect(reasons.filter(isPermanentIdleWait).sort()).toEqual(["gave-up", "unsupported-install"])
  })

  it("每种等待原因都有给人看的说明，没有空的", () => {
    const reasons: IdleRestartWaitReason[] = [
      "disabled", "nothing-ready", "downloading", "gave-up", "unsupported-install",
      "agent-busy", "recent-agent-activity", "queue-busy", "user-active", "unknown-state",
    ]
    for (const r of reasons) expect(idleRestartWaitText(r).length).toBeGreaterThan(3)
    // 永久原因的说明要告诉用户：退出应用时仍会安装
    expect(idleRestartWaitText("gave-up")).toContain("退出应用时仍会安装")
    expect(idleRestartWaitText("unsupported-install")).toContain("退出应用时仍会安装")
  })
})

describe("空闲自动重启的常量", () => {
  it("每分钟看一眼：既不是每秒轮询，也不会隔很久才发现人走了", () => {
    expect(IDLE_RESTART_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(10 * 1000)
    expect(IDLE_RESTART_CHECK_INTERVAL_MS).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  it("电脑空闲要足够久：至少 10 分钟（短于屏保和锁屏的常见时长就太冒进了）", () => {
    expect(IDLE_RESTART_USER_IDLE_SEC).toBeGreaterThanOrEqual(10 * 60)
  })

  it("Agent 安静时长要盖住一轮连着聊的回合间隔；重启后重试间隔要比一次安装的耗时长得多", () => {
    expect(IDLE_RESTART_AGENT_QUIET_MS).toBeGreaterThanOrEqual(5 * 60 * 1000)
    expect(IDLE_RESTART_RETRY_AFTER_MS).toBeGreaterThanOrEqual(5 * 60 * 1000)
    expect(IDLE_RESTART_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1)
    expect(IDLE_RESTART_MAX_ATTEMPTS).toBeLessThanOrEqual(3)
  })
})

describe("shouldStartHiddenAfterRestart（重启后窗口要不要留在托盘）", () => {
  const now = 1_000_000_000_000
  it("记号有效、重启前窗口收着：留在托盘", () => {
    expect(shouldStartHiddenAfterRestart({ at: now - 30_000, keepHidden: true }, now)).toBe(true)
  })

  it("重启前窗口本来就开着：照常弹出来", () => {
    expect(shouldStartHiddenAfterRestart({ at: now - 30_000, keepHidden: false }, now)).toBe(false)
  })

  it("没有记号（手动打开、开机自启）：照常弹出来", () => {
    expect(shouldStartHiddenAfterRestart(null, now)).toBe(false)
  })

  it("记号过期：作废，照常弹出来；刚好卡在时限上还算数", () => {
    expect(shouldStartHiddenAfterRestart({ at: now - RESTART_MARKER_TTL_MS, keepHidden: true }, now)).toBe(true)
    expect(shouldStartHiddenAfterRestart({ at: now - RESTART_MARKER_TTL_MS - 1, keepHidden: true }, now)).toBe(false)
  })

  it("记号的时间在未来（系统时间被改过）、或不是数字：不信，照常弹出来", () => {
    expect(shouldStartHiddenAfterRestart({ at: now + 60_000, keepHidden: true }, now)).toBe(false)
    expect(shouldStartHiddenAfterRestart({ at: Number.NaN, keepHidden: true }, now)).toBe(false)
    expect(shouldStartHiddenAfterRestart({ at: "x" as unknown as number, keepHidden: true }, now)).toBe(false)
  })

  it("keepHidden 不是严格的 true：不信", () => {
    expect(shouldStartHiddenAfterRestart({ at: now, keepHidden: "yes" as unknown as boolean }, now)).toBe(false)
  })

  it("时限要短：失败的重启不该长时间影响后面手动打开", () => {
    expect(RESTART_MARKER_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000)
    expect(RESTART_MARKER_TTL_MS).toBeGreaterThanOrEqual(60 * 1000)
  })
})
