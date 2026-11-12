/**
 * 主窗口的「外框」：不同系统的习惯不一样。
 *
 * - Windows / Linux：无边框窗口，标题栏右侧自绘 最小化 / 最大化 / 关闭。
 * - macOS：用系统自带的红绿灯（左上角；绿色是全屏），界面不再自绘按钮。
 *   之前所有系统都走自绘那一套，Mac 上按钮在右边、「最大化」只是铺满屏幕而不是全屏，铺满以后窗口还能拖，都不符合 Mac 的习惯。
 *
 * 纯函数、不依赖 Electron：主进程选窗口选项、界面决定标题栏布局都用这里，单测直接覆盖。
 */

/** 标题栏高度（px），和 TitleBar 的 h-12 一致 */
export const TITLE_BAR_HEIGHT = 48

/** 红绿灯按钮簇的高度（px，按系统实际样式取整） */
const MAC_BUTTONS_HEIGHT = 16

/** 红绿灯按钮簇左上角的位置：左边留 16px，垂直方向在标题栏里居中 */
export const MAC_TRAFFIC_LIGHT = { x: 16, y: (TITLE_BAR_HEIGHT - MAC_BUTTONS_HEIGHT) / 2 } as const

/** 标题栏左侧要给红绿灯让出的宽度：左边距 16 + 三个按钮和间隙约 52 + 和后面内容之间留 16 */
export const MAC_CONTROLS_INSET = 84

/** 创建主窗口时和「外框」有关的那几个选项（展开到 BrowserWindow 的选项里） */
export function windowChromeOptions(platform: string) {
  if (platform === "darwin") {
    // 隐藏标题栏但保留红绿灯，内容铺满整个窗口（和之前无边框时的布局一致）；窗口自带阴影、圆角和边缘缩放
    return { titleBarStyle: "hidden" as const, trafficLightPosition: { x: MAC_TRAFFIC_LIGHT.x, y: MAC_TRAFFIC_LIGHT.y } }
  }
  return { frame: false }
}

export interface TitleBarLayout {
  /** 要不要画自己的 最小化 / 最大化 / 关闭 */
  windowButtons: boolean
  /** 标题栏左侧内容要让出的宽度（px）；0 表示不用让，沿用原来的左边距 */
  leftInset: number
}

/**
 * 标题栏布局。macOS 全屏时红绿灯会收起来，这时不用再让位。
 * platform 取不到（旧版 preload、测试里的假 electronAPI）按 Windows 处理，和以前一致。
 */
export function titleBarLayout(platform: string | undefined, fullScreen: boolean): TitleBarLayout {
  if (platform !== "darwin") return { windowButtons: true, leftInset: 0 }
  return { windowButtons: false, leftInset: fullScreen ? 0 : MAC_CONTROLS_INSET }
}
