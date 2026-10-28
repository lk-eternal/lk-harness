/**
 * 「只认最新一轮」的刷新器：同一时刻最多一个请求在飞，飞行中再次触发会在它回来后再补一轮，
 * 并丢掉这一轮已经过时的结果。返回的 promise 在「触发之后拉到的那一轮」结果交出去后才完成，
 * 所以 `await run()` 之后界面上一定是比这次触发更新的数据。
 *
 * 典型用法：定时轮询 + 操作后立即刷新。没有它，「删完立刻刷新」可能撞上删之前发出的轮询，
 * 旧清单覆盖新清单，已删的行又冒出来。
 *
 * load 不应抛错（抛了会让当轮的调用方拿到 rejection，并结束这一串补拉）。
 */
export function createLatestRunner<T>(
  load: () => Promise<T>,
  onResult: (value: T) => void,
  isAlive: () => boolean = () => true,
): () => Promise<void> {
  let inflight: Promise<void> | null = null
  let rerun = false

  return function run(): Promise<void> {
    if (inflight) {
      rerun = true
      return inflight
    }
    inflight = (async () => {
      try {
        do {
          rerun = false
          const value = await load()
          if (!rerun && isAlive()) onResult(value)
        } while (rerun && isAlive())
      } finally {
        inflight = null
        rerun = false
      }
    })()
    return inflight
  }
}
