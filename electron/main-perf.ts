/** 主进程性能探针：事件循环滞后 + CPU/内存环形采样，供诊断包定位卡顿 hung 点。
 * 开销可忽略（10s 一次轻量采样，内存保留最近 36 个点）；行为零变化。 */

interface PerfSample {
  at: string
  /** 事件循环滞后 ms（定时器漂移）：持续 >1000 即主循环被闷住 */
  loopLagMs: number
  /** 10s 窗口内 CPU user+sys 微秒 */
  cpuUserUs: number
  cpuSysUs: number
  heapUsedMB: number
  heapTotalMB: number
  rssMB: number
}

const INTERVAL_MS = 10_000
const KEEP = 36

const samples: PerfSample[] = []
let timer: ReturnType<typeof setInterval> | null = null
let lastCpu = process.cpuUsage()
let lastTick = Date.now()

export function startMainPerfMonitor(): void {
  if (timer) return
  lastCpu = process.cpuUsage()
  lastTick = Date.now()
  timer = setInterval(() => {
    try {
      const now = Date.now()
      const expected = lastTick + INTERVAL_MS
      const loopLagMs = Math.max(0, now - expected)
      lastTick = now
      const cpu = process.cpuUsage(lastCpu)
      lastCpu = process.cpuUsage()
      const mem = process.memoryUsage()
      samples.push({
        at: new Date(now).toISOString(),
        loopLagMs,
        cpuUserUs: cpu.user,
        cpuSysUs: cpu.system,
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        heapTotalMB: Math.round(mem.heapTotal / 1048576),
        rssMB: Math.round(mem.rss / 1048576),
      })
      if (samples.length > KEEP) samples.splice(0, samples.length - KEEP)
    } catch { /* 探针永不干扰主流程 */ }
  }, INTERVAL_MS)
  if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
    (timer as unknown as { unref(): void }).unref()
  }
}

export function getMainPerfStats(): { samples: PerfSample[]; summary: Record<string, number | null> } {
  const lags = samples.map((s) => s.loopLagMs)
  const max = lags.length ? Math.max(...lags) : null
  const over1s = lags.filter((l) => l > 1000).length
  const last = samples[samples.length - 1]
  return {
    samples: [...samples],
    summary: {
      sampleCount: samples.length,
      maxLoopLagMs: max,
      over1sCount: over1s,
      lastHeapUsedMB: last?.heapUsedMB ?? null,
      lastRssMB: last?.rssMB ?? null,
    },
  }
}
