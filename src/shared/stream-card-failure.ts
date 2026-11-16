/**
 * 飞书流式卡片「更新失败」后的应对：退避、合并重复日志、体积超限时收紧预算。
 * 纯逻辑，daemon 和 lark-core 共用，单测不用起任何服务。
 *
 * 背景：流式卡每有一点新内容就整卡 PUT 一次（约每秒一次）。更新失败时过去什么都不做：
 * 下一次新内容照样再发一遍同样会失败的整卡，每次一条 WARN，失败多久就刷多久。
 */

/** 飞书错误码 200860：卡片内容超限（文档要求整张卡 30 KB 以内） */
export const CARD_OVER_SIZE_CODE = 200860

/** 体积预算收紧后的下限：再小就只剩壳子了，收紧到这里仍失败说明问题不在体积 */
export const STREAM_CARD_MIN_BYTE_BUDGET = 8 * 1024

/** 200860 之后把这张卡的体积预算收紧到 70%（不低于下限）。飞书的量法和我们的估算不一定一致，以它的报错为准 */
export function tightenByteBudget(current: number): number {
  return Math.max(STREAM_CARD_MIN_BYTE_BUDGET, Math.floor(current * 0.7))
}

/** 连续失败 n 次后，到下一次允许再更新要等多久：1s、2s、4s、8s，之后一直 8s；没失败过是 0 */
export function streamCardBackoffMs(failures: number): number {
  if (!Number.isFinite(failures) || failures < 1) return 0
  return Math.min(8000, 1000 * 2 ** (Math.floor(failures) - 1))
}

/**
 * 重复日志合并：同一个 key 在 intervalMs 内只打第一条，期间的只计数；
 * 过了间隔再出现时打一条并带上「期间合并了几条」。key 太多时丢最旧的，不无限增长。
 */
export class RepeatLogGate {
  private readonly entries = new Map<string, { lastLogAt: number; suppressed: number; total: number }>()

  constructor(
    private readonly intervalMs = 30_000,
    private readonly maxKeys = 200,
    private readonly now: () => number = Date.now,
  ) {}

  /** 这一条要不要打。要打返回 { merged: 距上一条之间被合并的条数 }，不打返回 null */
  shouldLog(key: string): { merged: number } | null {
    const t = this.now()
    const e = this.entries.get(key)
    if (!e) {
      if (this.entries.size >= this.maxKeys) this.entries.delete(this.entries.keys().next().value as string)
      this.entries.set(key, { lastLogAt: t, suppressed: 0, total: 1 })
      return { merged: 0 }
    }
    e.total++
    if (t - e.lastLogAt < this.intervalMs) {
      e.suppressed++
      return null
    }
    const merged = e.suppressed
    e.lastLogAt = t
    e.suppressed = 0
    return { merged }
  }

  /** 以 prefix 开头的 key 都结束了（比如这张卡更新成功了）：忘掉它们，返回期间一共失败过多少次 */
  resolve(prefix: string): number {
    let total = 0
    for (const [key, e] of this.entries) {
      if (!key.startsWith(prefix)) continue
      total += e.total
      this.entries.delete(key)
    }
    return total
  }
}
