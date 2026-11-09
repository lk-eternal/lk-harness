/**
 * 给可能挂住的异步调用设上限。
 *
 * Cursor SDK 的 Agent.resume / Agent.create 既没有超时也没有取消入口：网络半断时请求会一直挂着，
 * 直到底层放弃（实测一次 Resume 挂了 3 分 12 秒才报 "Network request failed"，期间用户什么回应都没有，
 * 紧接着的重试 1.5 秒就成功了）。
 *
 * 超时后调用方立刻拿到失败；底层调用没法取消，它之后若真的返回了结果（比如晚到的 Agent），
 * 交给 onLate 释放，否则就成了没人管的实例。晚到的失败直接吞掉：调用方早已处理过，再抛只会变成未处理的 rejection。
 */
export function boundedCall<T>(
  call: Promise<T>,
  ms: number,
  timeoutMessage: string,
  onLate: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(timeoutMessage))
    }, ms)
    call.then(
      (value) => {
        if (settled) {
          try { onLate(value) } catch { /* 释放失败不外泄 */ }
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export interface HedgeOptions<T> {
  /** 第一次调用这么久还没返回，就并行再发起一次；已经发出去的那次没法取消，留着等它自己结束 */
  hedgeAfterMs: number
  /** 总共最多并行发起几次（含第一次），默认 2 */
  maxAttempts?: number
  /** 从第一次发起起算的总时限，到点放弃 */
  timeoutMs: number
  timeoutMessage: string
  /**
   * 没被采用的结果：输给了别的调用（superseded），或超时之后才到（timeout）。
   * 必须释放，否则就是没人管的实例。晚到的失败直接吞掉。
   */
  onLate: (value: T, why: "superseded" | "timeout") => void
  /** 并行发起了第 n 次调用（n ≥ 2），给日志用 */
  onHedge?: (attempt: number) => void
}

/**
 * 慢了就并行再试一次，谁先成功用谁。
 *
 * Agent.resume 的耗时是长尾：绝大多数 2~4 秒，偶尔网络卡一下就是 30 秒甚至 3 分钟，而紧接着的重试往往 1~3 秒就好。
 * 光等着只会把用户晾在那儿，所以第一次迟迟不回就再发一次，不用等到总时限。
 *
 * - 第一次在 hedgeAfterMs 之前就失败：直接抛这个错误，不再发起第二次（失败是确定的，并行再试没意义）。
 * - 发起了多次：任何一次成功就用它；全部失败才失败，抛的是第一次的错误。
 * - timeoutMs 到点仍没有任何一次成功：抛 timeoutMessage。
 * - 输家 / 超时后才到的结果交给 onLate 释放。
 *
 * 只能用在重复发起没有副作用的调用上（Agent.resume 只是创建一个本地句柄，每次调用都是独立的运行时）。
 */
export function hedgedCall<T>(start: () => Promise<T>, opts: HedgeOptions<T>): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timedOut = false
    let started = 0
    let pending = 0
    let hasError = false
    let firstError: unknown
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined

    const clearTimers = (): void => {
      if (hedgeTimer) clearTimeout(hedgeTimer)
      if (deadline) clearTimeout(deadline)
    }
    const release = (value: T): void => {
      try { opts.onLate(value, timedOut ? "timeout" : "superseded") } catch { /* 释放失败不外泄 */ }
    }

    const launch = (): void => {
      started += 1
      pending += 1
      let call: Promise<T>
      try { call = start() } catch (e) { call = Promise.reject(e) }
      call.then(
        (value) => {
          pending -= 1
          if (settled) { release(value); return }
          settled = true
          clearTimers()
          resolve(value)
        },
        (err) => {
          pending -= 1
          if (settled) return
          if (!hasError) { hasError = true; firstError = err }
          if (pending > 0) return
          settled = true
          clearTimers()
          reject(firstError)
        },
      )
      if (started < maxAttempts) {
        hedgeTimer = setTimeout(() => {
          if (settled) return
          launch()
          try { opts.onHedge?.(started) } catch { /* 日志回调出错不能变成未捕获异常 */ }
        }, opts.hedgeAfterMs)
      }
    }

    deadline = setTimeout(() => {
      if (settled) return
      settled = true
      timedOut = true
      clearTimers()
      reject(new Error(opts.timeoutMessage))
    }, opts.timeoutMs)
    launch()
  })
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`

/**
 * Resume 超时的原因文案。launchSdkAgent 会把它拼成「Resume 暂不可用: …」往上报：
 * launch-fail-tracker 靠「暂不可用」判断这是瞬时故障（立即重试、不按配置类错误阶梯退避）。
 */
export function resumeTimeoutMessage(ms: number): string {
  return `${seconds(ms)} 内没有响应（网络可能不通）`
}

/** 创建 Agent 超时的整句文案（直接作为启动失败的原因往上报，同样要带「暂不可用」） */
export function createTimeoutMessage(ms: number): string {
  return `创建 Agent 暂不可用: ${seconds(ms)} 内没有响应（网络可能不通）`
}
