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
