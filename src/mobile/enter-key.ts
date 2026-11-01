/**
 * 输入框里按回车该做什么。
 * 手机软键盘上回车键的本意是换行，发送有专门的发送按钮；之前回车直接发送，没法在手机上换行。
 * 有实体键盘的设备（电脑浏览器）保持原来的习惯：回车发送，Shift+回车换行。
 * 任何设备上 Ctrl / ⌘ + 回车都发送，给手机外接键盘留一条快捷路径。
 */
export interface EnterKeyEvent {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  /** 输入法正在组字（拼音选词时的回车是确认候选，不是发送） */
  isComposing: boolean
}

export function shouldSendOnEnter(e: EnterKeyEvent, touchPrimary: boolean): boolean {
  if (e.key !== "Enter" || e.isComposing) return false
  if (e.ctrlKey || e.metaKey) return true
  if (e.shiftKey) return false
  return !touchPrimary
}

/** 主要输入方式是触屏（手指）。查不到时按「有键盘」处理，保持原来的行为 */
export function isTouchPrimary(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(pointer: coarse)").matches
}
