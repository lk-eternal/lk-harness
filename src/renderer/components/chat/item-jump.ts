// ── 对话列表：滚到某条记录并闪一下（点顶部浮条回到原消息、搜索定位共用）──────────────

/** 顶部浮条实色部分的高度（px）：记录的底边进到这个区域，就算「已滚出屏幕上沿」 */
export const DOCK_HEIGHT = 46
/** 滚到记录时，记录上沿离浮条下沿留的空隙（px） */
const JUMP_GAP = 12
const FLASH_MS = 900

/** 光圈沿着被闪的那块自己的圆角扩散，所以这里不写 borderRadius */
const FLASH_FRAMES: Keyframe[] = [
  { boxShadow: "0 0 0 0 var(--color-focus)" },
  { boxShadow: "0 0 0 10px transparent" },
]

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * 把记录滚到浮条下面并闪一下。
 * 闪的是带 data-user-flash 的块（用户消息的图片组和文字气泡：外层还包着下面的时间行，光圈不能把时间框进去）；
 * 没有这样的块就闪记录自己的第一个元素。
 */
export function scrollToItem(scroll: HTMLElement, el: HTMLElement): void {
  const reduced = prefersReducedMotion()
  scroll.scrollTo({
    top: scroll.scrollTop + el.getBoundingClientRect().top - scroll.getBoundingClientRect().top - DOCK_HEIGHT - JUMP_GAP,
    behavior: reduced ? "auto" : "smooth",
  })
  if (reduced) return
  const blocks = Array.from(el.querySelectorAll("[data-user-flash]"))
  const targets = blocks.length > 0 ? blocks : [el.firstElementChild ?? el]
  targets.forEach((block) => block.animate(FLASH_FRAMES, { duration: FLASH_MS, easing: "ease-out" }))
}
