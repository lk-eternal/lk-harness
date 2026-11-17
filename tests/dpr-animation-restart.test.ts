import { describe, expect, it } from "vitest"
import { browserEnv, installDprAnimationRestart, type DprRestartEnv } from "../src/renderer/dpr-animation-restart"

/** 假环境：手动改像素比、手动触发 change、手动推进帧，记录动画被停掉/恢复的顺序 */
function makeEnv(initialDpr = 1) {
  let dpr = initialDpr
  const queries: { query: string; listeners: Set<() => void> }[] = []
  let frames: Array<() => void> = []
  const log: string[] = []
  const env: DprRestartEnv = {
    devicePixelRatio: () => dpr,
    matchMedia(query) {
      const q = { query, listeners: new Set<() => void>() }
      queries.push(q)
      return {
        addEventListener: (_type, l) => { q.listeners.add(l) },
        removeEventListener: (_type, l) => { q.listeners.delete(l) },
      }
    },
    suspendAnimations() {
      log.push("suspend")
      return () => { log.push("resume") }
    },
    nextFrame(cb) { frames.push(cb) },
  }
  return {
    env,
    log,
    queries,
    /** 像素比变了：浏览器会通知「当前正监听着的那条查询」 */
    changeDpr(next: number) {
      dpr = next
      const active = [...queries].reverse().find((q) => q.listeners.size > 0)
      for (const l of [...(active?.listeners ?? [])]) l()
    },
    /** 推进一帧：执行此刻排队的所有帧回调 */
    runFrame() {
      const now = frames
      frames = []
      for (const cb of now) cb()
    },
  }
}

describe("installDprAnimationRestart：缩放/DPI 变化后重启动画", () => {
  it("装上时只监听当前像素比，不会立刻动动画", () => {
    const t = makeEnv(1.25)
    installDprAnimationRestart(t.env)
    expect(t.queries.map((q) => q.query)).toEqual(["(resolution: 1.25dppx)"])
    expect(t.queries[0].listeners.size).toBe(1)
    expect(t.log).toEqual([])
  })

  it("像素比变化：立刻停掉动画，撑满两帧后才恢复", () => {
    const t = makeEnv(1)
    installDprAnimationRestart(t.env)
    t.changeDpr(1.25)
    expect(t.log).toEqual(["suspend"])
    t.runFrame()
    expect(t.log).toEqual(["suspend"]) // 一帧还不够：样式可能还没生效
    t.runFrame()
    expect(t.log).toEqual(["suspend", "resume"])
  })

  it("变化后换成新的像素比重新监听，旧监听被摘掉；再变一次会再重启一次", () => {
    const t = makeEnv(1)
    installDprAnimationRestart(t.env)
    t.changeDpr(1.5)
    expect(t.queries.map((q) => q.query)).toEqual(["(resolution: 1dppx)", "(resolution: 1.5dppx)"])
    expect(t.queries[0].listeners.size).toBe(0)
    expect(t.queries[1].listeners.size).toBe(1)

    t.runFrame(); t.runFrame()
    t.changeDpr(1)
    t.runFrame(); t.runFrame()
    expect(t.log).toEqual(["suspend", "resume", "suspend", "resume"])
    expect(t.queries[2].query).toBe("(resolution: 1dppx)")
  })

  it("卸载后不再监听，也不再响应已经排队的 change", () => {
    const t = makeEnv(1)
    const dispose = installDprAnimationRestart(t.env)
    const staleListener = [...t.queries[0].listeners][0]
    dispose()
    expect(t.queries[0].listeners.size).toBe(0)
    staleListener() // 浏览器已经派发出来的回调
    expect(t.log).toEqual([])
    expect(t.queries).toHaveLength(1) // 也没有重新 arm
  })
})

describe("browserEnv：浏览器里的实现", () => {
  function makeDoc() {
    const appended: Array<{ attrs: Record<string, string>; textContent: string; removed: boolean }> = []
    let layoutReads = 0
    const doc = {
      createElement: () => {
        const el = {
          attrs: {} as Record<string, string>,
          textContent: "",
          removed: false,
          setAttribute(name: string, value: string) { el.attrs[name] = value },
          remove() { el.removed = true },
        }
        return el
      },
      head: { appendChild: (el: (typeof appended)[number]) => { appended.push(el) } },
      body: { get offsetHeight() { layoutReads += 1; return 0 } },
    }
    return { doc: doc as unknown as Document, appended, layoutReads: () => layoutReads }
  }

  it("停动画 = 往 head 里塞一条 animation:none!important 的样式，并读一次布局让它马上生效；恢复 = 把样式摘掉", () => {
    const { doc, appended, layoutReads } = makeDoc()
    const env = browserEnv({} as Window, doc)
    const resume = env.suspendAnimations()
    expect(appended).toHaveLength(1)
    expect(appended[0].textContent).toBe("*,*::before,*::after{animation:none!important}")
    expect(appended[0].attrs["data-dpr-animation-restart"]).toBe("")
    expect(layoutReads()).toBe(1)
    expect(appended[0].removed).toBe(false)
    resume()
    expect(appended[0].removed).toBe(true)
  })

  it("像素比和 matchMedia 都直接取自 window", () => {
    const seen: string[] = []
    const win = {
      devicePixelRatio: 2,
      matchMedia: (q: string) => { seen.push(q); return { addEventListener() {}, removeEventListener() {} } },
      requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 1 },
    } as unknown as Window
    const env = browserEnv(win, makeDoc().doc)
    expect(env.devicePixelRatio()).toBe(2)
    env.matchMedia("(resolution: 2dppx)")
    expect(seen).toEqual(["(resolution: 2dppx)"])
    let called = 0
    env.nextFrame(() => { called += 1 })
    expect(called).toBe(1)
  })
})
