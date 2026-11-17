/**
 * 缩放比例（Ctrl +/-）或所在屏幕的 DPI 变化之后，把页面里所有 CSS 动画重启一遍。
 *
 * 现象：会话栏里同时有两个转圈，一个原地转、完全对称；另一个绕着偏了约 1px 的点转，偶发，
 *       切换会话或改一下窗口大小后又正常了。
 * 原因：设备像素比变化后，Chromium 里跑在合成线程上的旋转动画层，偶发地「层的位置更新了，
 *       层里已光栅化的内容没跟上」，旋转支点和画出来的图形差了整整一个像素，之后不会自己恢复。
 *       在 Electron 41 里把缩放调到 125% 再调回 100% 能稳定复现；加 will-change、外面包一层容器都挡不住，
 *       只有让动画层重新建立（动画去掉再加回、或元素重建）才能恢复。
 * 做法：设备像素比一变，就临时加一条 `animation: none !important` 的样式，强制样式重算，
 *       等两帧再撤掉，动画层随之重建。页面里的动画基本都是 animate-spin 这类无限循环的，重启无感。
 */

/** 监听设备像素比变化所需要的最小能力（只用到 change 事件） */
export interface ResolutionQuery {
  addEventListener(type: "change", listener: () => void): void
  removeEventListener(type: "change", listener: () => void): void
}

/** 抽出来方便测试：浏览器里的真实实现见 {@link browserEnv} */
export interface DprRestartEnv {
  devicePixelRatio(): number
  matchMedia(query: string): ResolutionQuery
  /** 让页面里所有动画先停掉并立即生效，返回「恢复」函数 */
  suspendAnimations(): () => void
  /** 下一帧回调 */
  nextFrame(cb: () => void): void
}

/** 动画停掉后要保持的帧数：一帧可能赶在样式生效前，两帧才稳 */
const SUSPEND_FRAMES = 2

/**
 * 装上监听；返回卸载函数。设备像素比每变一次就重启一次动画。
 * 查询串里带着当前的像素比，变化后要换成新值重新监听。
 */
export function installDprAnimationRestart(env: DprRestartEnv = browserEnv()): () => void {
  let query: ResolutionQuery | null = null
  let disposed = false

  const onChange = (): void => {
    if (disposed) return
    restartAnimations(env)
    arm()
  }

  const arm = (): void => {
    query?.removeEventListener("change", onChange)
    query = env.matchMedia(`(resolution: ${env.devicePixelRatio()}dppx)`)
    query.addEventListener("change", onChange)
  }

  arm()
  return () => {
    disposed = true
    query?.removeEventListener("change", onChange)
    query = null
  }
}

/** 把页面动画停掉、等两帧再恢复 */
export function restartAnimations(env: DprRestartEnv): void {
  const resume = env.suspendAnimations()
  let left = SUSPEND_FRAMES
  const tick = (): void => {
    left -= 1
    if (left > 0) env.nextFrame(tick)
    else resume()
  }
  env.nextFrame(tick)
}

const SUSPEND_CSS = "*,*::before,*::after{animation:none!important}"

export function browserEnv(win: Window = window, doc: Document = document): DprRestartEnv {
  return {
    devicePixelRatio: () => win.devicePixelRatio,
    matchMedia: (query) => win.matchMedia(query),
    suspendAnimations: () => {
      const style = doc.createElement("style")
      style.setAttribute("data-dpr-animation-restart", "")
      style.textContent = SUSPEND_CSS
      doc.head.appendChild(style)
      // 读一次布局属性，逼浏览器马上按「无动画」重算样式；否则两次样式变更可能被合并成没变
      void doc.body.offsetHeight
      return () => style.remove()
    },
    nextFrame: (cb) => { win.requestAnimationFrame(() => cb()) },
  }
}
