/** 二级导航 Panel 共用布局 class */
/** 列表↔详情间距 gap-4；详情区 mr-4 作右侧外边距，pr-2 让滚动条与输入框留缝 */
export const PANEL_FRAME = "flex min-h-0 w-full flex-1 flex-col pl-2 pt-2"
export const PANEL_ROOT = "flex min-h-0 flex-1 gap-4"
export const PANEL_ASIDE = "flex w-40 shrink-0 flex-col border-r border-gray-800 pl-2 pr-2"
export const PANEL_LIST = "min-h-0 flex-1 space-y-1 overflow-y-auto"
export const PANEL_MAIN = "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
export const PANEL_SCROLL = "flex-1 space-y-3 overflow-y-auto pr-2 mr-4"
export const PANEL_SCROLL_FLAT = "flex-1 space-y-0 overflow-y-auto pr-2 mr-4"
export const PANEL_FOOTER = "flex shrink-0 items-center justify-between border-t border-gray-800 py-4 mr-4"

export function mcpEntryKey(source: "claw" | "global" | "project", name: string): string {
  return `${source}:${name}`
}
